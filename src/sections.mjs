// Fork addition: folding sections. A tab's items, each in one section per level (a repo's pull
// requests, files of one repo, the links one message mentions...), become the list the panel
// shows: a header item before each section, with its item count, and nothing of a folded
// section but its header. The headers are items too, so the cursor reaches a folded section.

// list: the items in section order (one section's items together).
// groupsOf(x): the item's section keys, outermost first; a key is unique in the list.
// folded(key): whether that section is folded.
// hidden(x): an item counted in its sections but not shown (the branches past "+N more").
// -> [{ kind: "section", group, depth, n, folded, first }, item, ...]
export function sectioned(list, groupsOf, folded, hidden = () => false) {
  const counts = new Map();
  for (const x of list) for (const g of groupsOf(x)) counts.set(g, (counts.get(g) || 0) + 1);
  const out = [];
  let open = []; // the section keys of the previous item
  for (const x of list) {
    const groups = groupsOf(x);
    let shut = false;
    groups.forEach((g, depth) => {
      if (open[depth] !== g) {
        open = [...open.slice(0, depth), g];
        if (!shut) out.push({ kind: "section", group: g, depth, n: counts.get(g), folded: !!folded(g), first: x });
      }
      shut ||= !!folded(g);
    });
    open = open.slice(0, groups.length);
    if (!shut && !hidden(x)) out.push(x);
  }
  return out;
}

// A view's fold state: what you chose, else the default (some sections start folded).
export function foldState(defaults = new Set()) {
  const chosen = new Map();
  return {
    folded: (g) => (chosen.has(g) ? chosen.get(g) : defaults.has(g)),
    toggle(g) { chosen.set(g, !(chosen.has(g) ? chosen.get(g) : defaults.has(g))); },
  };
}
