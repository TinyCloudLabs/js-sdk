/*
 * Lazy panel-data entry. panel-data-loader.ts loads it on the first panel read, so the
 * live adapter and its schema mapping stay out of the eager root (12 KiB gzip
 * budget, contracts-ade §1.4). The root reaches it only through dynamic import().
 */
export { createRealPanelData } from "./data/real";
