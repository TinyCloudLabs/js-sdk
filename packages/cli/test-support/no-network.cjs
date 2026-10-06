// Preload (`node --require`) that fails the process on any network attempt.
// Each attempt is appended to $TC_NO_NETWORK_LOG before it throws, so a test
// can prove a command never tried, even if the command swallowed the error.
const fs = require("node:fs");
const net = require("node:net");
const dns = require("node:dns");

function blocked(what) {
  if (process.env.TC_NO_NETWORK_LOG) fs.appendFileSync(process.env.TC_NO_NETWORK_LOG, `${what}\n`);
  throw new Error(`network attempt blocked: ${what}`);
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = args[0];
  // Local IPC (Unix sockets) is not network.
  if (options && typeof options === "object" && options.path) return connect.apply(this, args);
  return blocked(`connect ${JSON.stringify(options)}`);
};
dns.lookup = (host) => blocked(`dns ${host}`);
globalThis.fetch = (url) => blocked(`fetch ${String(url)}`);
