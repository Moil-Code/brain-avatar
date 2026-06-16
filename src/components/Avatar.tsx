import type { AvatarState } from "../lib/types";

interface Props {
  state: AvatarState;
  onClick?: () => void;
}

const LABELS: Record<AvatarState, string> = {
  idle: "Ready",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

/** Animated orb that reflects the assistant's current state. */
export default function Avatar({ state, onClick }: Props) {
  return (
    <div className="avatar-wrap" onClick={onClick} title="Brain Avatar">
      <div className={`orb orb-${state}`}>
        <div className="orb-core" />
        <div className="orb-ring orb-ring-1" />
        <div className="orb-ring orb-ring-2" />
        {state === "thinking" && (
          <div className="orb-dots">
            <span /> <span /> <span />
          </div>
        )}
        {state === "listening" && (
          <div className="orb-bars">
            <span /> <span /> <span /> <span />
          </div>
        )}
        {state === "speaking" && (
          <div className="orb-wave">
            <span /> <span /> <span /> <span /> <span />
          </div>
        )}
      </div>
      <div className="avatar-label">{LABELS[state]}</div>
    </div>
  );
}
