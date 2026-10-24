/**
 * Entry of the lazy dialog chunk. The permission and space-creation dialogs, their focus and scroll
 * handling and the manager that mounts them live behind this module, so a page that never prompts
 * never loads them. Evaluating it registers the manager (see ModalManager.ts).
 */
export { ModalManager, showPermissionRequestModal, showSpaceCreationModal } from "./ModalManager";
