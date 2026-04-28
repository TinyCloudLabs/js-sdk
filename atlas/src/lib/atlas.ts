// src/lib/atlas.ts
// Build-time data loader. Reads JSON from /public/data so the same
// files are both bundled into the static site and curl-able at the
// /js-sdk/atlas/data/*.json endpoints.
//
// During `astro build` these are read from disk via Node's fs API; the
// resulting pages are fully static.

import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_ROOT = path.resolve(process.cwd(), 'public/data');

async function readJson<T>(rel: string): Promise<T> {
  const full = path.join(DATA_ROOT, rel);
  const raw = await fs.readFile(full, 'utf8');
  return JSON.parse(raw) as T;
}

export interface Repo { owner: string; name: string; ref: string; sha: string; version: string; builtAt: string; drift: number }
export interface Chapter { id: string; title: string; voice: string; read: string }
export interface Endpoint { method: string; path: string; desc: string }
export interface PackageRef { id: string; npm: string; kind: string; side: string; ref: string }
export interface Package {
  id: string; npm: string; kind: string; side: string;
  modules: number; loc: number;
  why: string;
  boundaries: { id: string; kind: string }[];
  exports: { name: string; kind: string }[];
  changed: number; hasFsm: boolean; hasSeq: boolean;
  cmds?: string[];
}

export interface Inventory {
  repo: Repo; packages: PackageRef[]; chapters: Chapter[]; endpoints: Endpoint[];
  generated: { at: string; by: string; recipe: string };
}

export async function getInventory(): Promise<Inventory> {
  return readJson<Inventory>('inventory.json');
}

export async function getPackage(id: string): Promise<Package> {
  const fname = id.replace(/\//g, '__');
  return readJson<Package>(`pkg/${fname}.json`);
}

export async function getAllPackages(): Promise<Package[]> {
  const inv = await getInventory();
  return Promise.all(inv.packages.map(p => getPackage(p.id)));
}

export async function getFlow(id: string) { return readJson<any>(`flow/${id}.json`); }
export async function getState(id: string) { return readJson<any>(`state/${id}.json`); }
export async function getCommands() { return readJson<any>('cmds.json'); }
export async function getDrift() { return readJson<any>('drift.json'); }
export async function getArtifacts() { return readJson<any>('artifacts.json'); }
export async function getMeta() { return readJson<any>('meta.json'); }

export function pkgIdToRoute(id: string) { return id.replace(/\//g, '--'); }
export function routeToPkgId(route: string) { return route.replace(/--/g, '/'); }
