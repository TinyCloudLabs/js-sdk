// Narrow, browser-safe credential core for the web-sdk root barrel. Exports only
// the interpreter, the HTTP transport, and the type surface. Email-proof, the
// pending store, and holder code are deliberately excluded so the root bundle
// does not carry them. Full driver: ./index.ts.
export * from "./types";
export { interpretCredentialFlow, mailboxSubject } from "./interpreter";
export { OpenCredentialsHttpTransport } from "./transport";
