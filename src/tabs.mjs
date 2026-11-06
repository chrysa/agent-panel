// Which tab to open on when the panel starts or follows another session.
// The saved tab wins, except an empty Subagents tab: with no subagent in the last
// 30 min it would fill the panel with "none", so the panel opens on what the
// session does have, To do first (what is left for you), else Messages.
// The saved choice is not changed, so a session with subagents opens on them again.
export function openingTab(saved, { subagents = 0, todos = 0 } = {}) {
  if (saved !== "subagents" || subagents > 0) return saved;
  return todos > 0 ? "todo" : "messages";
}
