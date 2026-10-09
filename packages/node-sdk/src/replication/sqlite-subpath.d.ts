/**
 * node-sdk compiles with `moduleResolution: "node"` (node10), which cannot
 * resolve `@tinycloud/replica`'s `exports` map and so cannot see the
 * `/sqlite` subpath's types. Node itself loads the subpath through the
 * exports map at runtime — this ambient declaration only teaches the
 * compiler to read the same declaration file directly. Remove when the
 * package moves to Node16/bundler resolution.
 */
declare module "@tinycloud/replica/sqlite" {
  export * from "@tinycloud/replica/dist/sqlite";
}
