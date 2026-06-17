import type { TaskBoard as Board, TaskStatus } from "../lib/types";

const LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "Doing",
  done: "Done",
  blocked: "Blocked",
};
const COLUMNS: TaskStatus[] = ["todo", "in_progress", "done", "blocked"];
const cls = (s: TaskStatus) => (s === "in_progress" ? "doing" : s);

/** Presentational kanban strip shown under the chat. Renders nothing until the
 *  agent has actually created a board, so single-task turns stay clean. Collapsed
 *  is a one-line count strip; expanded shows the four columns with cards. */
export default function TaskBoard({
  board,
  expanded,
  onToggle,
}: {
  board: Board | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!board || board.tasks.length === 0) return null;

  const counts = { todo: 0, doing: 0, done: 0, blocked: 0 };
  for (const t of board.tasks) {
    if (t.status === "in_progress") counts.doing++;
    else counts[t.status as "todo" | "done" | "blocked"]++;
  }

  if (!expanded) {
    return (
      <button
        className="board-strip"
        onClick={onToggle}
        aria-expanded="false"
        aria-label={
          `Task board: ${counts.todo} to do, ${counts.doing} doing, ${counts.done} done` +
          (counts.blocked ? `, ${counts.blocked} blocked` : "") + ". Click to expand."
        }
      >
        <span className="board-strip-icon" aria-hidden>
          ▤
        </span>
        <span className="board-strip-counts">
          {counts.doing > 0 && <span className="bsc s-doing">{counts.doing} doing</span>}
          {counts.todo > 0 && <span className="bsc s-todo">{counts.todo} to do</span>}
          {counts.done > 0 && <span className="bsc s-done">{counts.done} done</span>}
          {counts.blocked > 0 && <span className="bsc s-blocked">{counts.blocked} blocked</span>}
        </span>
        <span className="board-strip-chevron" aria-hidden>
          ▾
        </span>
      </button>
    );
  }

  return (
    <section className="board" role="region" aria-label="Task board" aria-live="polite">
      <header className="board-head">
        <span className="board-title">Tasks</span>
        <button className="board-collapse" onClick={onToggle} aria-expanded="true" aria-label="Collapse task board">
          ▴
        </button>
      </header>
      <div className="board-cols" role="list">
        {COLUMNS.map((s) => {
          const cards = board.tasks.filter((x) => x.status === s);
          return (
            <div key={s} className={`board-col s-${cls(s)}`}>
              <div className="board-col-head">
                <span className="board-col-label">{LABELS[s]}</span>
                <span className="board-col-count">{cards.length}</span>
              </div>
              <div className="board-col-cards">
                {cards.map((card) => (
                  <article key={card.id} className={`board-card s-${cls(s)}`} role="listitem" tabIndex={0}>
                    <div className="board-card-title">
                      {card.title}
                      {card.attempt_count > 1 && (
                        <span className="board-card-attempt" title={`${card.attempt_count} attempts`}>
                          ×{card.attempt_count}
                        </span>
                      )}
                    </div>
                    {s === "done" && card.evidence && (
                      <div className="board-card-evidence" title={card.evidence}>
                        ✓ {card.evidence}
                      </div>
                    )}
                    {s === "blocked" && card.blocker && (
                      <div className="board-card-evidence warn" title={card.blocker}>
                        ⚠ {card.blocker}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
