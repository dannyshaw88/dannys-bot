/*
 * Aura Farming additions to Gnirehtet (Apache-2.0):
 * route a device's TCP connections through its assigned upstream proxy.
 */

use mio::net::{TcpStream, UdpSocket};
use std::io::{self, Read, Write};
use std::net::{
    Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream as StdTcpStream, ToSocketAddrs,
    UdpSocket as StdUdpSocket,
};
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct UpstreamProxy {
    protocol: String,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
}

impl UpstreamProxy {
    pub fn from_environment() -> io::Result<Option<Self>> {
        let protocol = match std::env::var("AURA_PROXY_TYPE") {
            Ok(protocol) => protocol,
            Err(std::env::VarError::NotPresent) => return Ok(None),
            Err(error) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    error.to_string(),
                ));
            }
        };
        let host = std::env::var("AURA_PROXY_HOST")
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
        let port = std::env::var("AURA_PROXY_PORT")
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?
            .parse::<u16>()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
        if host.trim().is_empty() || port == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Upstream proxy host and port are required",
            ));
        }
        if protocol != "http" && protocol != "socks5" {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Unsupported upstream proxy protocol; refusing direct fallback",
            ));
        }
        Ok(Some(Self {
            protocol,
            host,
            port,
            username: std::env::var("AURA_PROXY_USERNAME")
                .ok()
                .filter(|value| !value.is_empty()),
            password: std::env::var("AURA_PROXY_PASSWORD").ok(),
        }))
    }

    fn socket_addrs(&self) -> io::Result<Vec<SocketAddr>> {
        let address = if self.host.contains(':') && !self.host.starts_with('[') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        };
        address.to_socket_addrs().map(|items| items.collect())
    }

    pub fn connect_tcp(&self, destination: SocketAddrV4) -> io::Result<TcpStream> {
        let mut last_error = None;
        let proxy_addrs = self.socket_addrs()?;
        for proxy_address in proxy_addrs {
            let mut stream =
                match StdTcpStream::connect_timeout(&proxy_address, Duration::from_secs(4)) {
                    Ok(stream) => stream,
                    Err(error) => {
                        last_error = Some(error);
                        continue;
                    }
                };
            stream.set_read_timeout(Some(Duration::from_secs(5)))?;
            stream.set_write_timeout(Some(Duration::from_secs(5)))?;
            let result = if self.protocol == "http" {
                self.http_connect(&stream, destination)
            } else {
                self.socks5_connect(&mut stream, destination)
            };
            if let Err(error) = result {
                last_error = Some(error);
                continue;
            }
            stream.set_read_timeout(None)?;
            stream.set_write_timeout(None)?;
            stream.set_nonblocking(true)?;
            return TcpStream::from_stream(stream);
        }
        Err(last_error.unwrap_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "The upstream proxy resolved to no addresses",
            )
        }))
    }

    pub fn connect_socks5_udp(&self) -> io::Result<(UdpSocket, StdTcpStream)> {
        if self.protocol != "socks5" {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "UDP forwarding requires a SOCKS5 proxy",
            ));
        }
        let mut last_error = None;
        for proxy_address in self.socket_addrs()? {
            let result = self.open_socks5_udp_association(proxy_address);
            match result {
                Ok(association) => return Ok(association),
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.unwrap_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "The SOCKS5 proxy resolved to no addresses",
            )
        }))
    }

    fn open_socks5_udp_association(
        &self,
        proxy_address: SocketAddr,
    ) -> io::Result<(UdpSocket, StdTcpStream)> {
        let mut control = StdTcpStream::connect_timeout(&proxy_address, Duration::from_secs(4))?;
        control.set_read_timeout(Some(Duration::from_secs(5)))?;
        control.set_write_timeout(Some(Duration::from_secs(5)))?;
        self.socks5_negotiate(&mut control)?;
        control.write_all(&[0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0])?;

        let mut reply = [0u8; 4];
        control.read_exact(&mut reply)?;
        if reply[0] != 0x05 || reply[1] != 0x00 {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionRefused,
                format!("SOCKS5 UDP ASSOCIATE failed with reply code {}", reply[1]),
            ));
        }
        let relay_address = match reply[3] {
            0x01 => {
                let mut raw = [0u8; 6];
                control.read_exact(&mut raw)?;
                SocketAddr::V4(SocketAddrV4::new(
                    Ipv4Addr::new(raw[0], raw[1], raw[2], raw[3]),
                    u16::from_be_bytes([raw[4], raw[5]]),
                ))
            }
            0x03 => {
                let mut length = [0u8; 1];
                control.read_exact(&mut length)?;
                let mut raw = vec![0u8; length[0] as usize + 2];
                control.read_exact(&mut raw)?;
                let host = String::from_utf8_lossy(&raw[..length[0] as usize]).to_string();
                let port = u16::from_be_bytes([raw[raw.len() - 2], raw[raw.len() - 1]]);
                let relay_ip = (host.as_str(), port)
                    .to_socket_addrs()?
                    .find_map(|address| match address {
                        SocketAddr::V4(address) => Some(*address.ip()),
                        SocketAddr::V6(_) => None,
                    })
                    .ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::NotFound,
                            "SOCKS5 UDP relay hostname has no IPv4 address",
                        )
                    })?;
                SocketAddr::V4(SocketAddrV4::new(relay_ip, port))
            }
            0x04 => {
                let mut raw = [0u8; 18];
                control.read_exact(&mut raw)?;
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "SOCKS5 returned an IPv6 UDP relay, which this IPv4 tunnel cannot use",
                ));
            }
            atyp => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("SOCKS5 returned unknown UDP relay address type {}", atyp),
                ));
            }
        };
        let relay_address = match relay_address {
            SocketAddr::V4(address) if address.ip().is_unspecified() => match proxy_address {
                SocketAddr::V4(proxy) => {
                    SocketAddr::V4(SocketAddrV4::new(*proxy.ip(), address.port()))
                }
                SocketAddr::V6(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::Unsupported,
                        "SOCKS5 proxy resolved to IPv6; this tunnel supports IPv4 only",
                    ));
                }
            },
            SocketAddr::V4(address) => SocketAddr::V4(address),
            SocketAddr::V6(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "SOCKS5 UDP relay resolved to IPv6; this tunnel supports IPv4 only",
                ));
            }
        };
        let socket =
            StdUdpSocket::bind(SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0)))?;
        socket.connect(relay_address)?;
        socket.set_nonblocking(true)?;
        control.set_read_timeout(None)?;
        control.set_write_timeout(None)?;
        Ok((UdpSocket::from_socket(socket)?, control))
    }

    fn http_connect(&self, stream: &StdTcpStream, destination: SocketAddrV4) -> io::Result<()> {
        let mut request = format!(
            "CONNECT {}:{} HTTP/1.1\r\nHost: {}:{}\r\n",
            destination.ip(),
            destination.port(),
            destination.ip(),
            destination.port()
        );
        if let Some(username) = self.username.as_deref() {
            let credentials = format!("{}:{}", username, self.password.as_deref().unwrap_or(""));
            request.push_str(&format!(
                "Proxy-Authorization: Basic {}\r\n",
                base64_encode(credentials.as_bytes())
            ));
        }
        request.push_str("Proxy-Connection: Keep-Alive\r\n\r\n");
        let mut stream = stream;
        stream.write_all(request.as_bytes())?;

        let mut response = Vec::with_capacity(256);
        let mut byte = [0u8; 1];
        while response.len() < 16 * 1024 {
            stream.read_exact(&mut byte)?;
            response.push(byte[0]);
            if response.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        if !response.ends_with(b"\r\n\r\n") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Proxy response headers exceeded 16 KB",
            ));
        }
        let response = String::from_utf8_lossy(&response);
        let status_line = response.lines().next().unwrap_or("");
        if !(status_line.starts_with("HTTP/1.0 200") || status_line.starts_with("HTTP/1.1 200")) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("HTTP proxy rejected CONNECT: {}", status_line),
            ));
        }
        Ok(())
    }

    fn socks5_connect(
        &self,
        stream: &mut StdTcpStream,
        destination: SocketAddrV4,
    ) -> io::Result<()> {
        self.socks5_negotiate(stream)?;
        let mut request = vec![0x05, 0x01, 0x00, 0x01];
        request.extend_from_slice(&destination.ip().octets());
        request.extend_from_slice(&destination.port().to_be_bytes());
        stream.write_all(&request)?;

        let mut reply = [0u8; 4];
        stream.read_exact(&mut reply)?;
        if reply[0] != 0x05 || reply[1] != 0x00 {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionRefused,
                format!("SOCKS5 CONNECT failed with reply code {}", reply[1]),
            ));
        }
        match reply[3] {
            0x01 => {
                let mut address_and_port = [0u8; 6];
                stream.read_exact(&mut address_and_port)?;
            }
            0x03 => {
                let mut length = [0u8; 1];
                stream.read_exact(&mut length)?;
                let mut address_and_port = vec![0u8; length[0] as usize + 2];
                stream.read_exact(&mut address_and_port)?;
            }
            0x04 => {
                let mut address_and_port = [0u8; 18];
                stream.read_exact(&mut address_and_port)?;
            }
            atyp => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("SOCKS5 returned unknown address type {}", atyp),
                ));
            }
        }
        Ok(())
    }

    fn socks5_negotiate(&self, stream: &mut StdTcpStream) -> io::Result<()> {
        let has_auth = self.username.is_some();
        if has_auth {
            stream.write_all(&[0x05, 0x01, 0x02])?;
        } else {
            stream.write_all(&[0x05, 0x01, 0x00])?;
        }
        let mut method = [0u8; 2];
        stream.read_exact(&mut method)?;
        if method[0] != 0x05 || method[1] == 0xff {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "SOCKS5 proxy rejected the offered authentication methods",
            ));
        }

        if method[1] == 0x02 {
            let username = self.username.as_deref().unwrap_or("").as_bytes();
            let password = self.password.as_deref().unwrap_or("").as_bytes();
            if username.len() > 255 || password.len() > 255 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "SOCKS5 credentials exceed the protocol limit",
                ));
            }
            let mut auth = vec![0x01, username.len() as u8];
            auth.extend_from_slice(username);
            auth.push(password.len() as u8);
            auth.extend_from_slice(password);
            stream.write_all(&auth)?;
            let mut auth_response = [0u8; 2];
            stream.read_exact(&mut auth_response)?;
            if auth_response != [0x01, 0x00] {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "SOCKS5 username/password authentication failed",
                ));
            }
        } else if method[1] != 0x00 {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                format!("SOCKS5 selected unsupported auth method {}", method[1]),
            ));
        }
        Ok(())
    }
}

pub fn connect_tcp(destination: SocketAddrV4) -> io::Result<TcpStream> {
    match UpstreamProxy::from_environment()? {
        Some(proxy) => proxy.connect_tcp(destination),
        None => TcpStream::connect(&destination.into()),
    }
}

pub fn proxy_enabled() -> bool {
    std::env::var_os("AURA_PROXY_TYPE").is_some()
}

pub fn proxy_supports_udp() -> bool {
    std::env::var("AURA_PROXY_TYPE")
        .map(|protocol| protocol == "socks5")
        .unwrap_or(false)
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

#[cfg(test)]
mod tests {
    use super::{base64_encode, UpstreamProxy};
    use std::io::{Read, Write};
    use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
    use std::thread;

    fn read_headers(stream: &mut TcpStream) -> String {
        let mut response = Vec::new();
        let mut byte = [0u8; 1];
        while !response.ends_with(b"\r\n\r\n") && response.len() < 16 * 1024 {
            stream.read_exact(&mut byte).unwrap();
            response.push(byte[0]);
        }
        String::from_utf8(response).unwrap()
    }

    #[test]
    fn encodes_proxy_credentials_with_padding() {
        assert_eq!(base64_encode(b"user:pass"), "dXNlcjpwYXNz");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
    }

    #[test]
    fn http_proxy_connect_includes_authentication_and_target() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_headers(&mut stream);
            assert!(request.starts_with("CONNECT 203.0.113.5:443 HTTP/1.1\r\n"));
            assert!(request.contains("Proxy-Authorization: Basic dXNlcjpwYXNz\r\n"));
            stream
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .unwrap();
        });
        let proxy = UpstreamProxy {
            protocol: "http".into(),
            host: "127.0.0.1".into(),
            port,
            username: Some("user".into()),
            password: Some("pass".into()),
        };
        let destination = SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 5), 443);
        proxy.connect_tcp(destination).unwrap();
        server.join().unwrap();
    }

    #[test]
    fn http_proxy_rejection_fails_closed() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_headers(&mut stream);
            stream
                .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                .unwrap();
        });
        let proxy = UpstreamProxy {
            protocol: "http".into(),
            host: "127.0.0.1".into(),
            port,
            username: None,
            password: None,
        };
        let destination = SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 8), 443);
        assert!(proxy.connect_tcp(destination).is_err());
        server.join().unwrap();
    }

    #[test]
    fn socks5_proxy_authenticates_and_connects_to_target() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut greeting = [0u8; 3];
            stream.read_exact(&mut greeting).unwrap();
            assert_eq!(greeting, [0x05, 0x01, 0x02]);
            stream.write_all(&[0x05, 0x02]).unwrap();

            let mut auth_prefix = [0u8; 2];
            stream.read_exact(&mut auth_prefix).unwrap();
            let mut username = vec![0u8; auth_prefix[1] as usize];
            stream.read_exact(&mut username).unwrap();
            let mut password_length = [0u8; 1];
            stream.read_exact(&mut password_length).unwrap();
            let mut password = vec![0u8; password_length[0] as usize];
            stream.read_exact(&mut password).unwrap();
            assert_eq!(username, b"user");
            assert_eq!(password, b"pass");
            stream.write_all(&[0x01, 0x00]).unwrap();

            let mut request = [0u8; 10];
            stream.read_exact(&mut request).unwrap();
            assert_eq!(&request[..4], &[0x05, 0x01, 0x00, 0x01]);
            assert_eq!(&request[4..8], &[203, 0, 113, 7]);
            assert_eq!(&request[8..], &[0x01, 0xbb]);
            stream
                .write_all(&[0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50])
                .unwrap();
        });
        let proxy = UpstreamProxy {
            protocol: "socks5".into(),
            host: "127.0.0.1".into(),
            port,
            username: Some("user".into()),
            password: Some("pass".into()),
        };
        let destination = SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 7), 443);
        proxy.connect_tcp(destination).unwrap();
        server.join().unwrap();
    }
}
