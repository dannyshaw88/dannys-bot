import type { Contact, Scene, UiNode } from "./addFriendsReplayScene";
import { listTopFor, shortId } from "./addFriendsReplayScene";

const label = (node?: UiNode) => node?.text || node?.desc || "";
function NodeText({ node, color = "#222", size }: { node?: UiNode; color?: string; size: number }) {
  if (!node) return null;
  const [x, y, right, bottom] = node.bounds;
  const lineHeight = size * 1.3;
  const count = Math.max(1, Math.floor((bottom - y + size * 0.1) / lineHeight));
  const maxLength = Math.max(1, Math.floor((right - x) / (size * 0.5)));
  const words = label(node).split(/\s+/);
  const lines: string[] = [""];
  for (const word of words) {
    const index = lines.length - 1;
    if (lines[index] && `${lines[index]} ${word}`.length > maxLength && lines.length < count) lines.push(word);
    else lines[index] += `${lines[index] ? " " : ""}${word}`;
  }
  return <text fill={color} fontSize={size}>
    {lines.map((line, index) => <tspan key={index} x={x} y={y + size + index * lineHeight}>{line}</tspan>)}
  </text>;
}

export function AddFriendsReplayPhone({ scene, contacts, selected, onSelect, onAction, onUndo, running }: {
  scene: Scene; contacts: Contact[]; selected: string; running: boolean;
  onSelect: (name: string) => void;
  onAction: (action: "add" | "dismiss", name: string) => void;
  onUndo?: () => void;
}) {
  const s = scene.width / 1080;
  const listTop = listTopFor(scene);
  const navTop = scene.nodes.find(node => shortId(node) === "navigationBarBackground")?.bounds[1] ?? scene.height - 100 * s;
  const heading = scene.nodes.find(node => shortId(node) === "section-title" && /^find friends$/i.test(label(node)));
  const headingIndex = heading ? scene.nodes.indexOf(heading) : 0;
  const description = scene.nodes.slice(headingIndex + 1).find(node => shortId(node) === "section-description");
  const firstCardIndex = scene.nodes.findIndex((node, index) => index > headingIndex && shortId(node) === "scu_search_friend_cell");
  const headerDescription = description && scene.nodes.indexOf(description) < firstCardIndex ? description : undefined;
  const title = scene.nodes.find(node => shortId(node) === "add_friends_title");
  const search = scene.nodes.find(node => shortId(node) === "search-box");
  const searchTop = search?.bounds[1] ?? 219 * s;
  const searchBottom = search?.bounds[3] ?? 326 * s;
  const invite = scene.nodes.find(node => /invite your friends/i.test(label(node)) && node.bounds[1] > searchBottom);
  return <svg viewBox={`0 0 ${scene.width} ${scene.height}`} role="img" aria-label="Reconstructed Snapchat Add Friends screen"
    data-testid="screen-add-friends-simulator" className="block h-auto w-full overflow-hidden rounded-[2rem] border-[7px] border-neutral-900 bg-white shadow-xl">
    <defs><clipPath id="friend-list-clip"><rect x="0" y={listTop} width={scene.width} height={navTop - listTop} /></clipPath></defs>
    <rect width={scene.width} height={scene.height} fill="white" />
    <text x={40 * s} y={48 * s} fontSize={28 * s}>9:41</text>
    <NodeText node={title} size={40 * s} />
    <text x={45 * s} y={title?.bounds[3] ?? 190 * s} fontSize={50 * s}>⌄</text>
    <rect x={40 * s} y={searchTop} width={scene.width - 80 * s} height={searchBottom - searchTop} rx={50 * s} fill="#f1f1f3" />
    <text x={75 * s} y={(searchTop + searchBottom) / 2 + 10 * s} fontSize={32 * s} fill="#777">⌕  Search…</text>
    {invite && <NodeText node={invite} size={30 * s} />}
    <NodeText node={heading} size={32 * s} />
    <NodeText node={headerDescription} size={27 * s} color="#888" />
    <text x={scene.width - 290 * s} y={(heading?.bounds[1] ?? listTop - 60 * s) + 30 * s} fontSize={26 * s} fill="#777">All contacts ›</text>
    <g clipPath="url(#friend-list-clip)">
      {contacts.filter(contact => contact.bottom > listTop && contact.top < navTop).map((contact, index) => {
        const center = (contact.top + contact.bottom) / 2;
        const titleNode = contact.children.find(node => shortId(node) === "result-title");
        const reason = contact.children.find(node => shortId(node) === "result-reason");
        const avatar = contact.children.find(node => /^(avatar|snapchatter_avatar_thumbnail)$/.test(shortId(node)));
        const avatarX = avatar ? (avatar.bounds[0] + avatar.bounds[2]) / 2 : 112 * s;
        const avatarY = avatar ? (avatar.bounds[1] + avatar.bounds[3]) / 2 : center;
        const radius = avatar ? (avatar.bounds[2] - avatar.bounds[0]) / 2 : 67 * s;
        const added = contact.action === "Snap" || contact.action === "Message";
        return <g key={`${contact.name}-${index}`} data-testid={`card-sim-contact-${index}`} data-name={contact.name}
          data-height={contact.height} data-reason={contact.reason} role="group" onClick={() => onSelect(contact.name)}>
          <rect x="0" y={contact.top} width={scene.width} height={contact.height}
            fill={contact.dismissed ? "#eaeaea" : selected === contact.name ? "#f5fbff" : "white"} stroke="#ddd" strokeWidth={2 * s} />
          <circle cx={avatarX} cy={avatarY} r={radius} fill={["#f4dcd3", "#d7e5e2", "#e5ddf0", "#eee7ce"][index % 4]} />
          <text x={avatarX} y={avatarY + 12 * s} textAnchor="middle" fontSize={35 * s} fill="#666">
            {contact.name.split(/\s+/).slice(0, 2).map(word => [...word][0]).join("")}
          </text>
          {contact.dismissed ? <>
            <NodeText node={contact.children.find(node => shortId(node) === "feedback-title")} size={23 * s} color="#999" />
            {contact.children.filter(node => /^(fisrt-feedback|first-feedback|second-feedback)$/.test(shortId(node))).map(node =>
              <NodeText key={shortId(node)} node={node} size={29 * s} color="#12a9d4" />)}
            <g role="button" aria-label={`Undo dismiss ${contact.name}`} onClick={event => { event.stopPropagation(); onUndo?.(); }}>
              <NodeText node={contact.children.find(node => /^undo$/i.test(label(node)))} size={23 * s} color="#12a9d4" />
            </g>
          </> : <>
            <NodeText node={titleNode} size={35 * s} />
            {reason && <NodeText node={reason} size={23 * s} color="#888" />}
            <g role="button" tabIndex={0} aria-label={`Add ${contact.name}`} data-testid={`button-sim-add-${index}`}
              onClick={event => { event.stopPropagation(); if (!running) onAction("add", contact.name); }}
              onKeyDown={event => { if (event.key === "Enter" && !running) { event.stopPropagation(); onAction("add", contact.name); } }}>
              <rect x={709 * s} y={center - 44 * s} width={247 * s} height={88 * s} rx={44 * s} fill="#ffeb00" />
              <text x={832 * s} y={center + 12 * s} textAnchor="middle" fontSize={29 * s}>{added ? "Message  ▣" : "＋ Add"}</text>
            </g>
            <g role="button" tabIndex={0} aria-label={`Dismiss ${contact.name}`} data-testid={`button-sim-dismiss-${index}`}
              onClick={event => { event.stopPropagation(); if (!running) onAction("dismiss", contact.name); }}
              onKeyDown={event => { if (event.key === "Enter" && !running) { event.stopPropagation(); onAction("dismiss", contact.name); } }}>
              <rect x={972 * s} y={center - 36 * s} width={80 * s} height={72 * s} fill="transparent" />
              <text x={1012 * s} y={center + 12 * s} textAnchor="middle" fontSize={44 * s} fill="#bbb">×</text>
            </g>
          </>}
        </g>;
      })}
    </g>
    <rect y={navTop} width={scene.width} height={scene.height - navTop} fill="#333" />
    <circle cx={scene.width / 2} cy={(navTop + scene.height) / 2} r={20 * s} fill="#aaa" />
  </svg>;
}
