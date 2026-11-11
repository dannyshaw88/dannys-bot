/*
 * Copyright (C) 2017 Genymobile
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

use log::*;
use mio::net::UdpSocket;
use mio::{Event, PollOpt, Ready, Token};
use std::cell::RefCell;
use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream as StdTcpStream};
use std::rc::{Rc, Weak};
use std::time::Instant;

use super::binary;
use super::client::{Client, ClientChannel};
use super::connection::{Connection, ConnectionId};
use super::datagram::{DatagramReceiver, DatagramSender};
use super::datagram_buffer::DatagramBuffer;
use super::ipv4_header::Ipv4Header;
use super::ipv4_packet::{Ipv4Packet, MAX_PACKET_LENGTH};
use super::packetizer::Packetizer;
use super::selector::Selector;
use super::transport_header::TransportHeader;
use super::upstream_proxy;

const TAG: &str = "UdpConnection";

pub const IDLE_TIMEOUT_SECONDS: u64 = 2 * 60;

pub struct UdpConnection {
    id: ConnectionId,
    client: Weak<RefCell<Client>>,
    socket: UdpSocket,
    interests: Ready,
    token: Token,
    client_to_network: DatagramBuffer,
    network_to_client: Packetizer,
    closed: bool,
    idle_since: Instant,
    blocked_by_proxy: bool,
    socks5_udp: bool,
    _socks5_control: Option<StdTcpStream>,
}

impl UdpConnection {
    #[allow(clippy::needless_pass_by_value)] // semantically, headers are consumed
    pub fn create(
        selector: &mut Selector,
        id: ConnectionId,
        client: Weak<RefCell<Client>>,
        ipv4_header: Ipv4Header,
        transport_header: TransportHeader,
    ) -> io::Result<Rc<RefCell<Self>>> {
        cx_info!(target: TAG, id, "Open");
        let (socket, blocked_by_proxy, socks5_udp, socks5_control) = Self::create_socket(&id)?;
        let packetizer = Packetizer::new(&ipv4_header, &transport_header);
        let interests = Ready::readable();
        let rc = Rc::new(RefCell::new(Self {
            id,
            client,
            socket,
            interests,
            token: Token(0), // default value, will be set afterwards
            client_to_network: DatagramBuffer::new(4 * MAX_PACKET_LENGTH),
            network_to_client: packetizer,
            closed: false,
            idle_since: Instant::now(),
            blocked_by_proxy,
            socks5_udp,
            _socks5_control: socks5_control,
        }));

        {
            let mut self_ref = rc.borrow_mut();

            let rc2 = rc.clone();
            // must anotate selector type: https://stackoverflow.com/a/44004103/1987178
            let handler =
                move |selector: &mut Selector, event| rc2.borrow_mut().on_ready(selector, event);
            let token =
                selector.register(&self_ref.socket, handler, interests, PollOpt::level())?;
            self_ref.token = token;
        }
        Ok(rc)
    }

    fn create_socket(
        id: &ConnectionId,
    ) -> io::Result<(UdpSocket, bool, bool, Option<StdTcpStream>)> {
        if upstream_proxy::proxy_supports_udp() {
            let proxy = upstream_proxy::UpstreamProxy::from_environment()?.ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "SOCKS5 proxy is not configured",
                )
            })?;
            let (socket, control) = proxy.connect_socks5_udp()?;
            return Ok((socket, false, true, Some(control)));
        }
        let autobind_addr = SocketAddr::new(Ipv4Addr::new(0, 0, 0, 0).into(), 0);
        let udp_socket = UdpSocket::bind(&autobind_addr)?;
        let blocked_by_proxy =
            upstream_proxy::proxy_enabled() && id.rewritten_destination().port() != 53;
        if !blocked_by_proxy {
            udp_socket.connect(id.rewritten_destination().into())?;
        }
        Ok((udp_socket, blocked_by_proxy, false, None))
    }

    fn remove_from_router(&self) {
        // route is embedded in router which is embedded in client: the client necessarily exists
        let client_rc = self.client.upgrade().expect("Expected client not found");
        let mut client = client_rc.borrow_mut();
        client.router().remove(self);
    }

    fn on_ready(&mut self, selector: &mut Selector, event: Event) {
        #[allow(clippy::match_wild_err_arm)]
        match self.process(selector, event) {
            Ok(_) => (),
            Err(ref err) if err.kind() == io::ErrorKind::WouldBlock => {
                cx_debug!(target: TAG, self.id, "Spurious event, ignoring")
            }
            Err(_) => panic!("Unexpected unhandled error"),
        }
    }

    // return Err(err) with err.kind() == io::ErrorKind::WouldBlock on spurious event
    fn process(&mut self, selector: &mut Selector, event: Event) -> io::Result<()> {
        if !self.closed {
            self.touch();
            let ready = event.readiness();
            if ready.is_readable() || ready.is_writable() {
                if ready.is_writable() {
                    self.process_send(selector)?;
                }
                if !self.closed && ready.is_readable() {
                    self.process_receive(selector)?;
                }
                if !self.closed {
                    self.update_interests(selector);
                }
            } else {
                // error or hup
                self.close(selector);
            }
            if self.closed {
                // on_ready is not called from the router, so the connection must remove itself
                self.remove_from_router();
            }
        }
        Ok(())
    }

    // return Err(err) with err.kind() == io::ErrorKind::WouldBlock on spurious event
    fn process_send(&mut self, selector: &mut Selector) -> io::Result<()> {
        match self.write() {
            Ok(_) => (),
            Err(ref err) if err.kind() == io::ErrorKind::WouldBlock => {
                cx_debug!(target: TAG, self.id, "Spurious event, ignoring")
            }
            Err(err) => {
                if err.kind() == io::ErrorKind::WouldBlock {
                    // rethrow
                    return Err(err);
                }
                cx_error!(
                    target: TAG,
                    self.id,
                    "Cannot write: [{:?}] {}",
                    err.kind(),
                    err
                );
                self.close(selector);
            }
        }
        Ok(())
    }

    // return Err(err) with err.kind() == io::ErrorKind::WouldBlock on spurious event
    fn process_receive(&mut self, selector: &mut Selector) -> io::Result<()> {
        match self.read(selector) {
            Ok(_) => (),
            Err(err) => {
                if err.kind() == io::ErrorKind::WouldBlock {
                    // rethrow
                    return Err(err);
                }
                cx_error!(
                    target: TAG,
                    self.id,
                    "Cannot read: [{:?}] {}",
                    err.kind(),
                    err
                );
                self.close(selector);
            }
        }
        Ok(())
    }

    fn read(&mut self, selector: &mut Selector) -> io::Result<()> {
        let ipv4_packet = if self.socks5_udp {
            self.network_to_client.packetize(&mut Socks5UdpReceiver {
                socket: &self.socket,
            })?
        } else {
            self.network_to_client.packetize(&mut self.socket)?
        };
        let client_rc = self.client.upgrade().expect("Expected client not found");
        match client_rc
            .borrow_mut()
            .send_to_client(selector, &ipv4_packet)
        {
            Ok(_) => {
                cx_debug!(
                    target: TAG,
                    self.id,
                    "Packet ({} bytes) sent to client",
                    ipv4_packet.length()
                );
                if log_enabled!(target: TAG, Level::Trace) {
                    cx_trace!(
                        target: TAG,
                        self.id,
                        "{}",
                        binary::build_packet_string(ipv4_packet.raw())
                    );
                }
            }
            Err(_) => cx_warn!(target: TAG, self.id, "Cannot send to client, drop packet"),
        }
        Ok(())
    }

    fn write(&mut self) -> io::Result<()> {
        if self.blocked_by_proxy {
            struct Discard;
            impl super::datagram::DatagramSender for Discard {
                fn send(&mut self, buf: &[u8]) -> io::Result<usize> {
                    Ok(buf.len())
                }
            }
            self.client_to_network.write_to(&mut Discard)?;
        } else if self.socks5_udp {
            self.client_to_network.write_to(&mut Socks5UdpSender {
                socket: &self.socket,
                destination: self.id.rewritten_destination(),
            })?;
        } else {
            self.client_to_network.write_to(&mut self.socket)?;
        }
        Ok(())
    }

    fn update_interests(&mut self, selector: &mut Selector) {
        let ready = if self.client_to_network.is_empty() {
            Ready::readable()
        } else {
            Ready::readable() | Ready::writable()
        };
        cx_debug!(target: TAG, self.id, "interests: {:?}", ready);
        if self.interests != ready {
            // interests must be changed
            self.interests = ready;
            selector
                .reregister(&self.socket, self.token, ready, PollOpt::level())
                .expect("Cannot register on poll");
        }
    }

    fn touch(&mut self) {
        self.idle_since = Instant::now();
    }
}

struct Socks5UdpSender<'a> {
    socket: &'a UdpSocket,
    destination: SocketAddrV4,
}

impl DatagramSender for Socks5UdpSender<'_> {
    fn send(&mut self, payload: &[u8]) -> io::Result<usize> {
        let mut packet = Vec::with_capacity(payload.len() + 10);
        packet.extend_from_slice(&[0, 0, 0, 0x01]);
        packet.extend_from_slice(&self.destination.ip().octets());
        packet.extend_from_slice(&self.destination.port().to_be_bytes());
        packet.extend_from_slice(payload);
        let written = self.socket.send(&packet)?;
        if written != packet.len() {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "Partial SOCKS5 UDP datagram",
            ));
        }
        Ok(payload.len())
    }
}

struct Socks5UdpReceiver<'a> {
    socket: &'a UdpSocket,
}

impl DatagramReceiver for Socks5UdpReceiver<'_> {
    fn recv(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let mut packet = vec![0u8; output.len() + 22];
        let length = self.socket.recv(&mut packet)?;
        if length < 4 || packet[0..3] != [0, 0, 0] {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid SOCKS5 UDP header",
            ));
        }
        let address_length = match packet[3] {
            0x01 => 4,
            0x03 => {
                if length < 5 {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Truncated SOCKS5 UDP domain",
                    ));
                }
                packet[4] as usize + 1
            }
            0x04 => 16,
            atyp => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("Unknown SOCKS5 UDP address type {}", atyp),
                ));
            }
        };
        let header_length = 4 + address_length + 2;
        if length < header_length {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Truncated SOCKS5 UDP packet",
            ));
        }
        let payload_length = length - header_length;
        if payload_length > output.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "SOCKS5 UDP payload exceeds packet buffer",
            ));
        }
        output[..payload_length].copy_from_slice(&packet[header_length..length]);
        Ok(payload_length)
    }
}

impl Connection for UdpConnection {
    fn id(&self) -> &ConnectionId {
        &self.id
    }

    fn send_to_network(
        &mut self,
        selector: &mut Selector,
        _: &mut ClientChannel,
        ipv4_packet: &Ipv4Packet,
    ) {
        match self
            .client_to_network
            .read_from(ipv4_packet.payload().expect("No payload"))
        {
            Ok(_) => {
                self.update_interests(selector);
            }
            Err(err) => cx_warn!(
                target: TAG,
                self.id,
                "Cannot send to network, drop packet: {}",
                err
            ),
        }
    }

    fn close(&mut self, selector: &mut Selector) {
        cx_info!(target: TAG, self.id, "Close");
        self.closed = true;
        if let Err(err) = selector.deregister(&self.socket, self.token) {
            // do not panic, this can happen in mio
            // see <https://github.com/Genymobile/gnirehtet/issues/136>
            cx_warn!(
                target: TAG,
                self.id,
                "Fail to deregister UDP stream: {:?}",
                err
            );
        }
        // socket will be closed by RAII
    }

    fn is_expired(&self) -> bool {
        self.idle_since.elapsed().as_secs() > IDLE_TIMEOUT_SECONDS
    }

    fn is_closed(&self) -> bool {
        self.closed
    }
}

#[cfg(test)]
mod tests {
    use super::{Socks5UdpReceiver, Socks5UdpSender};
    use crate::relay::datagram::{DatagramReceiver, DatagramSender};
    use mio::net::UdpSocket;
    use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket as StdUdpSocket};

    #[test]
    fn socks5_udp_wraps_destination_and_unwraps_reply() {
        let relay = StdUdpSocket::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        relay
            .set_read_timeout(Some(std::time::Duration::from_secs(1)))
            .unwrap();
        let client_std = StdUdpSocket::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        client_std.connect(relay.local_addr().unwrap()).unwrap();
        client_std.set_nonblocking(true).unwrap();
        let client = UdpSocket::from_socket(client_std).unwrap();

        let destination = SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 10), 443);
        Socks5UdpSender {
            socket: &client,
            destination,
        }
        .send(b"request")
        .unwrap();
        let mut wrapped = [0u8; 64];
        let (wrapped_len, client_address) = relay.recv_from(&mut wrapped).unwrap();
        assert_eq!(&wrapped[..10], &[0, 0, 0, 1, 203, 0, 113, 10, 1, 0xbb]);
        assert_eq!(&wrapped[10..wrapped_len], b"request");

        relay
            .send_to(
                &[0, 0, 0, 1, 203, 0, 113, 10, 1, 0xbb, b'o', b'k'],
                client_address,
            )
            .unwrap();
        let mut response = [0u8; 64];
        let mut receiver = Socks5UdpReceiver { socket: &client };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        let received = loop {
            match receiver.recv(&mut response) {
                Ok(length) => break length,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "SOCKS5 UDP reply timed out"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                Err(error) => panic!("unexpected SOCKS5 UDP receive error: {}", error),
            }
        };
        assert_eq!(&response[..received], b"ok");
    }
}
