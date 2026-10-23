/**
 * Shared panel components from the settings mockup: confirm box, glance rows,
 * details drawer and receipt slip. Sections pass resolved text in; nothing here
 * reads client data or strings.ts. Each control is at least 44px tall.
 */

/** Light and dark tokens for these components, mirroring the mockup's hairline and chrome. */
export const UI_STYLE = `
.glance{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.glance-row{display:flex;align-items:center;gap:14px;width:100%;min-height:56px;padding:6px 6px 6px 0;border:0;border-bottom:1px solid #e4e4e7;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.glance-row:last-child{border-bottom:0}
.glance-row:focus-visible{outline:2px solid #111827;outline-offset:2px}
.glance-row .gl{flex:1;min-width:0}
.glance-row .gl b{display:block;font-size:14.5px;font-weight:600}
.glance-row .gl span{display:block;font-size:13px;color:#4b5563}
.glance-row .gr{display:flex;align-items:center;gap:10px;color:#4b5563}
.drawer{margin-top:12px;padding:14px 16px;border:1px solid #d4d4d8;border-radius:12px;background:#fafafa}
.drawer>h3{margin:0 0 8px;font-size:15px;font-weight:600;overflow-wrap:anywhere}
.slip{margin-top:8px;padding:8px 0;border-top:2px dashed #71717a;border-bottom:2px dashed #71717a;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.slip>div{display:flex;justify-content:space-between;gap:12px}
@media (prefers-color-scheme: dark){
.glance-row{border-bottom-color:#3f3f46}
.glance-row .gl span,.glance-row .gr{color:#a1a1aa}
.glance-row:focus-visible{outline-color:#fafafa}
.drawer{border-color:#3f3f46;background:#151517}
.slip{border-color:#71717a}
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

/**
 * Inline confirm for a destructive action. The cancel (safe) action comes first
 * in the DOM and is the one the caller focuses. The box is an alertdialog so a
 * screen reader announces the question.
 */
export function confirmBox(options: ConfirmOptions): ConfirmBox {
  const el = document.createElement("div");
  el.className = "confirm";
  el.setAttribute("role", "alertdialog");

  const question = document.createElement("p");
  question.className = "busy";
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

export interface GlanceRowOptions {
  readonly label: string;
  readonly sublabel: string;
  /** Short status word shown on the right. Optional. */
  readonly status?: string;
  readonly onOpen: () => void;
}

/** One "At a glance" row: a whole-row button with label, sublabel, optional status and a chevron. */
export function glanceRow(options: GlanceRowOptions): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "glance-row";
  row.addEventListener("click", options.onOpen);

  const text = document.createElement("span");
  text.className = "gl";
  const label = document.createElement("b");
  label.textContent = options.label;
  const sublabel = document.createElement("span");
  sublabel.textContent = options.sublabel;
  text.append(label, sublabel);

  const end = document.createElement("span");
  end.className = "gr";
  if (options.status !== undefined) {
    const status = document.createElement("span");
    status.textContent = options.status;
    end.append(status);
  }
  const chevron = document.createElement("span");
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "›";
  end.append(chevron);

  row.append(text, end);
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

/** Receipt slip: dashed-rule block of label/value rows. Values are text, never markup. */
export function receiptSlip(rows: readonly { readonly label: string; readonly value: string }[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "slip";
  for (const row of rows) {
    const line = document.createElement("div");
    const label = document.createElement("span");
    label.textContent = row.label;
    const value = document.createElement("span");
    value.textContent = row.value;
    line.append(label, value);
    el.append(line);
  }
  return el;
}
