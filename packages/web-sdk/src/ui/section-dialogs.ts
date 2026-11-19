import type { ConfirmHandle, ConfirmRequest, DrawerHandle, DrawerRequest } from "./slots";
import { confirmBox, detailsDrawer } from "./sections/ui";

/** `ctx.confirm` and `ctx.openDrawer`, bound to whichever section element is mounted. */
export interface SectionDialogs {
  confirm(request: ConfirmRequest): ConfirmHandle;
  openDrawer(request: DrawerRequest): DrawerHandle;
  /** Removes every box and drawer still open. The shell calls it when the section unmounts. */
  closeAll(): void;
}

function place(host: HTMLElement | undefined, anchor: HTMLElement | undefined, node: HTMLElement): void {
  if (anchor !== undefined) anchor.after(node);
  else host?.append(node);
}

export function createSectionDialogs(getHost: () => HTMLElement | undefined): SectionDialogs {
  const open = new Set<HTMLElement>();

  /** Removes `el` if it is still open. True when this call closed it. */
  function remove(el: HTMLElement): boolean {
    if (!open.delete(el)) return false;
    el.remove();
    return true;
  }

  return {
    confirm(request) {
      const made = confirmBox({
        question: request.question,
        cancelLabel: request.cancelLabel,
        confirmLabel: request.confirmLabel,
        onCancel: () => {
          if (remove(made.el)) request.onCancel?.();
        },
        onConfirm: request.onConfirm,
      });
      open.add(made.el);
      place(getHost(), request.anchor, made.el);
      // The safe action takes focus, so Enter keeps things as they are.
      made.cancel.focus();
      return { cancel: made.cancel, confirm: made.confirm, close: () => void remove(made.el) };
    },
    openDrawer(request) {
      const el = detailsDrawer({
        title: request.title,
        body: request.body,
        closeLabel: request.closeLabel,
        onClose: () => {
          if (remove(el)) request.onClose?.();
        },
      });
      open.add(el);
      place(getHost(), request.anchor, el);
      const heading = el.querySelector<HTMLElement>("h3");
      heading?.setAttribute("tabindex", "-1");
      heading?.focus();
      return { el, close: () => void remove(el) };
    },
    closeAll() {
      for (const el of [...open]) remove(el);
    },
  };
}
