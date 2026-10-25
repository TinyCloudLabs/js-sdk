
const path = require("path");
const webpack = require("webpack");

const isProduction = process.env.NODE_ENV === "production";

const rules = [
  {
    test: /\.tsx?$/,
    use: "ts-loader",
    exclude: /node_modules/,
  },
  {
    // Handle ES modules properly
    test: /\.m?js$/,
    resolve: {
      fullySpecified: false,
    },
  },
];

const plugins = [
  new webpack.ProvidePlugin({
    Buffer: ["buffer", "Buffer"],
    process: "process/browser",
  }),
  new webpack.DefinePlugin({
    global: "globalThis",
  }),
  // Handle node: scheme imports by removing the node: prefix
  new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
    resource.request = resource.request.replace(/^node:/, "");
  }),
  // Replace @noble/hashes/crypto import to use browser version
  new webpack.NormalModuleReplacementPlugin(
    /@noble\/hashes\/crypto$/,
    path.resolve(__dirname, "src/polyfills/noble-crypto-browser.mjs")
  ),
  {
    apply(compiler) {
      compiler.hooks.compilation.tap("NoReplica", (compilation) =>
        compilation.hooks.finishModules.tap("NoReplica", (modules) => {
          for (const module of modules) {
            if (/[\\/](packages[\\/]replica|@tinycloud[\\/]replica)[\\/]/.test(module.resource ?? "")) {
              compilation.errors.push(
                new compiler.webpack.WebpackError(`web-sdk must not bundle replica code: ${module.resource}`)
              );
            }
          }
        })
      );
    },
  },
];

const resolveConfig = {
  extensions: [".tsx", ".ts", ".js", ".mjs"],
  // Add conditionNames to properly resolve ES modules with browser support
  conditionNames: ["browser", "import", "require", "default"],
  // Enable browser field support
  mainFields: ["browser", "module", "main"],
  fallback: {
    // Existing polyfills
    util: require.resolve("util/"),
    path: require.resolve("path-browserify"),
    buffer: require.resolve("buffer/"),
    os: require.resolve("os-browserify/browser"),
    url: require.resolve("url/"),
    stream: require.resolve("stream-browserify"),
    https: require.resolve("https-browserify"),
    assert: require.resolve("assert/"),
    http: require.resolve("stream-http"),
    events: require.resolve("events/"),
    process: require.resolve("process/browser"),

    // Additional polyfills for missing modules
    crypto: require.resolve("crypto-browserify"),
    zlib: require.resolve("browserify-zlib"),
    vm: require.resolve("vm-browserify"),

    // These modules don't work in browsers, so we disable them
    fs: false,
    net: false,
    tls: false,
    child_process: false,

    // Handle node: scheme imports
    "node:crypto": false,  // Disable node:crypto entirely for browser
    "node:buffer": require.resolve("buffer/"),
    "node:util": require.resolve("util/"),
    "node:stream": require.resolve("stream-browserify"),
    "node:path": require.resolve("path-browserify"),
    "node:events": require.resolve("events/"),
    "node:url": require.resolve("url/"),
    "node:vm": require.resolve("vm-browserify"),
    "node:fs": false,
    "node:net": false,
    "node:tls": false,
    "node:os": require.resolve("os-browserify/browser"),
  },
};

// The links reader of `@tinycloud/share-envelope` is its own file, loaded by an `import()` when a share link is first
// resolved or published. It stays a package import (the bundle does not carry it), like the replica deferred imports
// below; `@tinycloud/share-envelope` is a dependency of this package.
const LINKS_REQUEST = "@tinycloud/share-envelope/links";
const linksExternal = ({ request }, callback) => {
  if (request === LINKS_REQUEST) {
    callback(null, `import ${request}`);
    return;
  }
  callback();
};

const baseConfig = {
  mode: isProduction ? "production" : "development",
  target: "web",
  entry: "./src/index.ts",
  devtool: isProduction ? false : 'source-map',
  module: { rules },
  resolve: resolveConfig,
  externals: [linksExternal],
  optimization: {
    splitChunks: false,
    runtimeChunk: false,
    // Disable HMR and development optimizations in production
    ...(isProduction && {
      minimize: true,
    }),
  },
  plugins: [
    ...plugins,
    // Keep the package bundle self-contained for downstream bundlers like CRA.
    new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
  ],
  // Prevent webpack from injecting Node.js polyfills for global, __filename, __dirname
  node: false,
};

const esmConfig = {
  ...baseConfig,
  output: {
    filename: "index.mjs",
    path: path.resolve(__dirname, "dist"),
    globalObject: "globalThis",
    library: {
      type: "module",
    },
    module: true,
    environment: {
      module: true,
    },
  },
  experiments: {
    outputModule: true,
  },
};

const cjsConfig = {
  ...baseConfig,
  output: {
    filename: "index.cjs",
    path: path.resolve(__dirname, "dist"),
    globalObject: "globalThis",
    library: {
      type: "commonjs2",
    },
    // The deferred import of the links reader is a real `import()` in the CommonJS bundle too.
    environment: { dynamicImport: true },
  },
};

// Browser adapter and Node-only profile gate stay external and load on demand.
// The parser remains a package external so web-sdk never embeds replica source.
const replicaExternals = (moduleType) => ({ context, request }, callback) => {
  if (request === "./index" && context === path.resolve(__dirname, "src")) {
    callback(null, `${moduleType} @tinycloud/web-sdk`);
    return;
  }
  if (request === "./replica-gated" && context === path.resolve(__dirname, "src")) {
    callback(null, `${moduleType} @tinycloud/web-sdk/replica-gated`);
    return;
  }
  if (request === LINKS_REQUEST) {
    callback(null, `import ${request}`);
    return;
  }
  if (request && /^@tinycloud\/replica(?:\/|$)/.test(request)) {
    const deferred = request === "@tinycloud/replica/kv-storage" || request === "@tinycloud/replica/profile-gate";
    callback(null, `${deferred ? "import" : moduleType} ${request}`);
    return;
  }
  callback();
};

const replicaSharedPlugins = [
  new webpack.NormalModuleReplacementPlugin(
    /^@tinycloud\/sdk-core$/,
    path.resolve(__dirname, "src/replica-core-bridge.ts")
  ),
  new webpack.NormalModuleReplacementPlugin(
    /^@tinycloud\/sdk-services$/,
    path.resolve(__dirname, "src/replica-services-bridge.ts")
  ),
  new webpack.NormalModuleReplacementPlugin(
    /^siwe$/,
    path.resolve(__dirname, "src/replica-siwe-bridge.ts")
  ),
];

const replicaEsmConfig = {
  ...esmConfig,
  entry: "./src/replica.ts",
  externals: replicaExternals("module"),
  plugins: [...esmConfig.plugins, ...replicaSharedPlugins],
  output: { ...esmConfig.output, filename: "replica.mjs" },
};

const replicaCjsConfig = {
  ...cjsConfig,
  entry: "./src/replica.ts",
  externals: replicaExternals("commonjs"),
  plugins: [...cjsConfig.plugins, ...replicaSharedPlugins],
  output: {
    ...cjsConfig.output,
    filename: "replica.cjs",
    environment: { ...cjsConfig.output.environment, dynamicImport: true },
  },
};

const gatedEsmConfig = {
  ...replicaEsmConfig,
  entry: "./src/replica-gated.ts",
  output: { ...replicaEsmConfig.output, filename: "replica-gated.mjs" },
};
const gatedCjsConfig = {
  ...replicaCjsConfig,
  entry: "./src/replica-gated.ts",
  output: { ...replicaCjsConfig.output, filename: "replica-gated.cjs" },
};

// Headless subpath (`@tinycloud/web-sdk/credentials`). Built from the base
// configs only: no replica externals or plugins, so index/replica are unchanged.
const credentialsEsmConfig = {
  ...esmConfig,
  entry: "./src/credentials-subpath.ts",
  output: { ...esmConfig.output, filename: "credentials.mjs" },
};
const credentialsCjsConfig = {
  ...cjsConfig,
  entry: "./src/credentials-subpath.ts",
  output: { ...cjsConfig.output, filename: "credentials.cjs" },
};

module.exports = [
  esmConfig,
  cjsConfig,
  replicaEsmConfig,
  replicaCjsConfig,
  gatedEsmConfig,
  gatedCjsConfig,
  credentialsEsmConfig,
  credentialsCjsConfig,
];
