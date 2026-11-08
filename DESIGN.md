# agent-panel — Design contract

> Contract for the herdr side panel and message popup of this fork of
> [flowy11/agent-panel](https://github.com/flowy11/agent-panel). Read it before changing what
> the panel shows, how it reacts to keys or what the fork adds; update it in the same change.
> Status: **[implemented]** links the code · **[decided]** names the decision · **[proposed]**
> is not agreed. Upstream owns the panel; this fork owns only the header lines and the
> shown-agent marker ([AGENTS.md](AGENTS.md)). Changes to upstream behaviour are proposed
> upstream, not redesigned here.

## 1. Surface and status

- **Surface:** interactive terminal UI in Node.js, hosted by herdr: a split pane docked on the
  right of a Claude Code or Codex tab, and a popup for one message. **[implemented]**
  ([panel.mjs](src/panel.mjs), [message.mjs](src/message.mjs),
  [herdr-plugin.toml](herdr-plugin.toml))
- **Lifecycle:** shipped upstream (0.4.2); this repository is a fork kept in sync by a weekly
  pull request ([upstream-sync.yml](.github/workflows/upstream-sync.yml)). Fork additions:
  [header.mjs](src/header.mjs) and the `shown/<pane id>` marker.
- **Detailed specs:** none; user documentation in [README.md](README.md).

## 2. Users, devices and priority tasks

| User | Context and device | Priority tasks (three at most) |
| --- | --- | --- |
| Developer running Claude Code or Codex in herdr | Linux or macOS terminal, panel beside the agent all day | follow subagents and their progress · find a message or a file/URL the agent mentioned · keep track of what the agent asked the user to do |

Primary action per tab: *Subagents* — open the running subagent; *Messages* — read one in full;
*Refs* — open the reference; *To do* — check an item off.

## 3. Journeys and navigation

- **J1 — Follow subagents:** the panel docks itself when a tab runs an agent (`tab.focused`,
  `workspace.focused`, `pane.agent_detected`) → *Subagents* lists `●` running, `◌` stalled
  (silent 5 min), `✓` done, `✗` failed, `⊘` killed, with progress bars from `PROGRESS:` lines →
  Enter switches Claude to that subagent. During a permission prompt it does nothing; while
  switching the footer says `switching…`. **[implemented]** ([panel.mjs](src/panel.mjs),
  [claude.mjs](src/claude.mjs))
- **J2 — Read a message:** *Messages* → Enter opens the popup (80 % × 85 %) → `j`/`k`, `←`/`→`,
  `y` copies, Esc closes. If herdr refuses the popup, the message expands in the panel with a
  note. **[implemented]**
- **J3 — Act on a request:** *To do* shows the latest `ACTION:` list with its age; `x` checks an
  item off (kept per session), `y` copies its command. **[implemented]**
- **J4 — Header (fork):** an executable named in `header-command` runs every 3 s with
  `<cwd> <provider> <session id> <agent pane id>`; up to six lines are shown above the tab bar,
  colours kept, other control sequences dropped. **[implemented]** ([header.mjs](src/header.mjs))
- **Information architecture:** four tabs (`←`/`→`, `Tab`, `1`–`4`, click); a footer names the
  keys of the current tab; `q` closes the panel in this tab only, the *show / hide* action brings
  it back. Key table: [README.md](README.md).
- **Density:** compact — a message uses up to three lines, the *Finished* section folds (`f`).

## 4. Identity

A plain terminal tool owned upstream: no logo or palette. Sender dots identify who wrote a
message (blue *you*, orange *Claude*, green *Codex*), always next to the name. The selected item
carries a cyan bar in the margin. **[implemented]** ([text.mjs](src/text.mjs))

## 5. Tokens and components (owned elsewhere)

| Concern | Source of truth | Rules of use |
| --- | --- | --- |
| Colour roles | `c` and `WHO` in [text.mjs](src/text.mjs) | 16-colour ANSI plus one 256-colour orange |
| Status glyphs | `ICON` in [panel.mjs](src/panel.mjs) | one shape per subagent state |
| Layout | `SIDE_RATIO` in [lib.mjs](src/lib.mjs); pane sizes in [herdr-plugin.toml](herdr-plugin.toml) | agent keeps 78 % of the tab |
| Text fitting | `fit`, `fitMiddle`, `wrap`, `charWidth` in [text.mjs](src/text.mjs) | cut with `…`; paths keep their end; wide characters count double |
| Header (fork) | `EVERY_MS`, `MAX_LINES` in [header.mjs](src/header.mjs) | 3 s, six lines; colour only when the line fits |
| Motion | none | terminal output does not animate |

- **Shared contract:** `contract.css` and `@chrysa/ui` do not apply to a terminal surface.

## 6. Interaction and states

- **Action feedback:** copy shows `Copied …` or `No clipboard tool found`; switching shows
  `switching…`; a refused popup says why and expands in place. **[implemented]**
- **Forms:** none.
- **Data states:**

  | State | Where it appears | Behaviour |
  | --- | --- | --- |
  | Loading | panel, header | no loading text; the header stays empty until its first run |
  | Empty | every tab | `No messages yet`, `No subagents in this session`, `None in the last 30 min — a shows all`, `The agent hasn't mentioned any URLs or files yet`, `No supported agent session in this tab` |
  | Error | refs, header | missing files dimmed with `?`; a failing header command hides the header without a message |
  | Offline / backend unreachable | panel | data is local; when the agent quits, the panel closes after 5 s |
  | Stale data | subagents, to do | `◌` stalled after 5 min of silence; the To-do header shows the list's age |
  | Reconnect | panel | after a herdr restart, dead panels are closed and the panel docks again |

- **Real-time:** data refreshes every second. The cursor stays on its item; a wheel-scrolled
  view stays put, or sticks to the bottom when it was there. **[implemented]**
  ([panel.mjs](src/panel.mjs))
- **Motion:** none (FE-053, terminal: no animation).

## 7. Responsive and support conventions

Needs herdr ≥ 0.8.2 and Node.js. Alternate screen, SGR mouse reporting (clicks and wheel) and a
full redraw on resize. In a narrow panel tab names shorten (`Messages` → `Msgs` → `M`) and the
footer is cut with `…`. Every mouse action has a key.

## 8. Accessibility

- **Target:** terminal readability; meaning never by colour alone.
- **Perception:** each subagent state has its own glyph; sender dots sit next to the sender's
  name. **[implemented]**
- **Keyboard:** full key parity with the mouse; `q`/Esc never trap. **[implemented]**
- **Gaps:** `NO_COLOR` is not honoured (colours are constants in [text.mjs](src/text.mjs)); no
  screen-reader pass.

## 9. Assets

| Asset | Source or generator | Author | Licence and attribution | Permitted use | Formats and variants | Location |
| --- | --- | --- | --- | --- | --- | --- |
| Demo animation | screen recording (upstream) | upstream maintainer | unknown: no LICENSE file in the repository | README illustration | GIF, 3.7 MB | [docs/demo.gif](docs/demo.gif) |
| Demo video | screen recording (upstream) | upstream maintainer | unknown: no LICENSE file in the repository | README link | MP4, 4.9 MB | [docs/demo.mp4](docs/demo.mp4) |

No fonts or icons are shipped; glyphs are Unicode characters.

## 10. Acceptance criteria and evidence

- **Criteria:** each tab names its empty state; a subagent's state is readable without colour;
  every mouse action has a key; header output keeps only SGR colours, at most six lines, cut to
  the panel width ([header.test.mjs](test/header.test.mjs)); provider parsing stays stable
  ([providers.test.mjs](test/providers.test.mjs)).
- **Evidence log:**

  | Date | Change | Checks run (tool, sizes, modes) | Result | Not run, and why |
  | --- | --- | --- | --- | --- |
  | 2026-11-08 | contract written from the code | source review | gaps listed in §11 | no terminal run: documentation-only change |

## 11. Open choices, known gaps and maintenance

- **Open choices:**
  - **[proposed]** show one dim line when the header command fails, instead of hiding it.
  - **[proposed]** propose `NO_COLOR` support upstream.
- **Known gaps:** the repository has no LICENSE file, so the terms of the code and of the demo
  media are not recorded; 8.6 MB of demo media is tracked in git.
- **Maintenance:** owner of this fork. Update this file with any change to the header or the
  marker; review it when an upstream-sync pull request changes the panel's tabs, keys or states.
