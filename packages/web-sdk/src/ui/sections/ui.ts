/**
 * Shared panel components from the settings mockup: confirm box, glance rows,
 * details drawer. Sections pass resolved text in; nothing here
 * reads client data or strings.ts. Each control is at least 44px tall.
 */
import type { SectionStatus } from "../slots";

/** Light and dark tokens for these components, mirroring the mockup's hairline and chrome. */
export const UI_STYLE = `
.glance{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.glance-row{display:flex;align-items:center;gap:14px;width:100%;min-height:56px;padding:6px 6px 6px 0;border:0;border-bottom:1px solid #e4e4e7;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.glance-row:last-child{border-bottom:0}
.glance-row .gl{flex:1;min-width:0}
.glance-row .gl b{display:block;font-size:14.5px;font-weight:600}
.glance-row .gl span{display:block;font-size:13px;color:#71717a}
.glance-row .gr{display:flex;align-items:center;gap:10px;color:#71717a}
.glance-row .gr .ui-ic{width:16px;height:16px}
.glance-row .gi{display:inline-flex;flex:none;color:#71717a}
.glance-row .gi .ui-ic{width:20px;height:20px}
.ui-ic{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.st{display:inline-flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;white-space:nowrap}
.st .dot{top:auto;right:auto;width:9px;height:9px;border:0;border-radius:50%;background:transparent;flex:none;position:relative}
.st-ok{color:#18181b}
.st-ok .dot{background:currentColor}
.st-warn{color:#92400e}
/* Warning colour from the mockup (panel-mock index.html: --tc-color-warning #b35309 light line 34, #fbbd23 dark line 57; .st-warn .dot line 259). */
.st-warn .dot{background:#b35309;box-shadow:0 0 0 1.5px #fff,0 0 0 2.5px #b35309}
.st-off,.st-info{color:#71717a}
.st-off .dot,.st-info .dot{box-shadow:inset 0 0 0 2px currentColor}
.st-info .dot::after{content:"";position:absolute;left:-1px;right:-1px;top:3.5px;height:2px;background:currentColor;transform:rotate(-45deg)}
.drawer{margin-top:12px;padding:14px 16px;border:1px solid #d4d4d8;border-radius:12px;background:#fafafa}
.drawer>h3{margin:0 0 8px;font-size:15px;font-weight:600;overflow-wrap:anywhere}
@media (prefers-color-scheme: dark){
.glance-row{border-bottom-color:#3f3f46}
.glance-row .gl span,.glance-row .gr{color:#a1a1aa}
.drawer{border-color:#3f3f46;background:#151517}
.st-ok{color:#fafafa}
.st-warn{color:#fcd34d}
.st-warn .dot{background:#fbbd23;box-shadow:0 0 0 1.5px #151517,0 0 0 2.5px #fbbd23}
.st-off,.st-info{color:#a1a1aa}
}
`;

/** A `button.action` (44px minimum, from panel-styles). */
export function actionButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "action";
  button.textContent = label;
  return button;
}

export interface ConfirmOptions {
  readonly question: string;
  /** The safe action. It is focused by the caller; Enter and Escape take it. */
  readonly cancelLabel: string;
  readonly confirmLabel: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export interface ConfirmBox {
  readonly el: HTMLElement;
  /** Focus this after the box is attached. It is the safe action. */
  readonly cancel: HTMLButtonElement;
  readonly confirm: HTMLButtonElement;
}

let confirmSeq = 0;

/**
 * Inline confirm for a destructive action. The cancel (safe) action comes first
 * in the DOM and is the one the caller focuses. The box is an alertdialog whose
 * question is its description, so a screen reader reads the question when focus
 * lands on the safe action. Each box gets its own id, so two boxes never collide.
 */
export function confirmBox(options: ConfirmOptions): ConfirmBox {
  const el = document.createElement("div");
  el.className = "confirm";
  el.setAttribute("role", "alertdialog");
  const questionId = `tc-confirm-q-${++confirmSeq}`;
  el.setAttribute("aria-describedby", questionId);
  // Escape takes the safe action, as the mockup's design rules require. Stopping
  // propagation keeps the panel's own Escape handler from closing the drawer.
  // While the destructive action runs both buttons are disabled: Escape is
  // swallowed then, so the box stays and focus stays where it is.
  el.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (cancel.disabled || confirm.disabled) return;
    options.onCancel();
  });

  const question = document.createElement("p");
  question.className = "busy";
  question.id = questionId;
  question.textContent = options.question;

  const actions = document.createElement("div");
  actions.className = "actions";

  const cancel = actionButton(options.cancelLabel);
  cancel.addEventListener("click", options.onCancel);
  const confirm = actionButton(options.confirmLabel);
  confirm.addEventListener("click", options.onConfirm);

  actions.append(cancel, confirm);
  el.append(question, actions);
  return { el, cancel, confirm };
}

/** Icon paths from the settings mockup's sprite, stroked with currentColor. Static constants only. */
const ICON_PATHS = {
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  sync: '<path d="M4 12a8 8 0 0 1 14-5l2 2M20 4v5h-5M20 12a8 8 0 0 1-14 5l-2-2M4 20v-5h5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>',
  nodes: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.5 6h7M7.2 8.2l3.6 7.6M16.8 8.2l-3.6 7.6"/>',
  drive: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M3 13l3-8h12l3 8M7 16.5h.01"/>',
  term: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 10l3 2-3 2M13 15h4"/>',
  chev: '<path d="M9 5l7 7-7 7"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/>',
  out: '<path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5M16 8l4 4-4 4M20 12H9"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  warn: '<path d="M12 3l10 18H2zM12 10v5M12 18h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  eyeoff: '<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6zM4 4l16 16"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

/** A decorative 18px icon. The path is a static constant, so innerHTML takes no user input. */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ui-ic");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = ICON_PATHS[name];
  return svg;
}

/** Status text with the mockup dot: solid for ok, ringed for warn, hollow for off, hollow with a slash for info. */
export function statusNode(status: SectionStatus): HTMLSpanElement {
  const node = document.createElement("span");
  node.className = `st st-${status.tone}`;
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.setAttribute("aria-hidden", "true");
  const word = document.createElement("span");
  word.textContent = status.text;
  node.append(dot, word);
  return node;
}

export interface GlanceRowOptions {
  readonly icon: IconName;
  readonly label: string;
  readonly sublabel: string;
  readonly status?: SectionStatus;
  readonly onOpen: () => void;
}

/** One "At a glance" row: icon, label, sublabel, optional status, and a chevron. */
export function glanceRow(options: GlanceRowOptions): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "glance-row";
  row.addEventListener("click", options.onOpen);

  const glyph = document.createElement("span");
  glyph.className = "gi";
  glyph.append(icon(options.icon));

  const text = document.createElement("span");
  text.className = "gl";
  const label = document.createElement("b");
  label.textContent = options.label;
  const sublabel = document.createElement("span");
  sublabel.textContent = options.sublabel;
  text.append(label, sublabel);

  const end = document.createElement("span");
  end.className = "gr";
  if (options.status !== undefined) end.append(statusNode(options.status));
  end.append(icon("chev"));

  row.append(glyph, text, end);
  return row;
}

export interface DrawerOptions {
  readonly title: string;
  readonly body: readonly Node[];
  readonly closeLabel: string;
  readonly onClose: () => void;
}

/** Inline details drawer: a titled region with a close action. */
export function detailsDrawer(options: DrawerOptions): HTMLElement {
  const el = document.createElement("section");
  el.className = "drawer";
  el.setAttribute("role", "region");

  const heading = document.createElement("h3");
  heading.textContent = options.title;
  const close = actionButton(options.closeLabel);
  close.addEventListener("click", options.onClose);

  el.append(heading, ...options.body, close);
  return el;
}

/** Replaces a row's status in place, so a refresh keeps focus on the row. Undefined clears it. */
export function setGlanceStatus(row: HTMLButtonElement, status: SectionStatus | undefined): void {
  const end = row.querySelector(".gr");
  if (end === null) return;
  end.querySelector(".st")?.remove();
  if (status !== undefined) end.prepend(statusNode(status));
}
