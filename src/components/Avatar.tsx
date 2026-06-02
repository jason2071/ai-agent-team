import type { Agent } from "../agents";

// sprite staff กลาง — fallback เมื่อ agent ไม่ได้กำหนด avatar เอง
const GUILD_SPRITE = "/assets/guild_staff/staff/Lilia.png";

export function Avatar({
  agent,
  size = 44,
  active = false,
}: {
  agent: Agent;
  size?: number;
  active?: boolean;
}) {
  return (
    <div
      className="avatar"
      style={{
        width: size,
        height: size,
        borderColor: agent.accent,
        boxShadow: active ? `0 0 0 2px ${agent.accent}, 0 0 16px ${agent.accent}55` : "none",
      }}
    >
      <img src={agent.avatar || GUILD_SPRITE} alt={agent.name} />
    </div>
  );
}
