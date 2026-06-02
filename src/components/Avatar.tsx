import type { Agent } from "../agents";

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
      {agent.avatar ? (
        <img src={agent.avatar} alt={agent.name} />
      ) : (
        <span style={{ color: agent.accent, fontSize: size * 0.36 }}>
          {agent.initials}
        </span>
      )}
    </div>
  );
}
