// TC-380 PROOF: deliberate type error planted in a package no old filter covered.
export const tc380PlantedFailure: number = "this is not a number";

export {
  TinyCloudVfsProvider,
  createTinyCloudVfs,
  createTinyCloudVfsFromNode,
  createTinyCloudDelegatedVfs,
} from "./TinyCloudVfsProvider";

export type {
  TinyCloudVfsMetadata,
  TinyCloudVfsOptions,
  TinyCloudVfsProviderOptions,
  TinyCloudVfsSessionData,
  TinyCloudVfsSource,
  CreateTinyCloudDelegatedVfsOptions,
  CreateTinyCloudNodeVfsOptions,
} from "./types";
