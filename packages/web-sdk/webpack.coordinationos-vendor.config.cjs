const path = require("path");
const [esmConfig] = require("./webpack.config.cjs");

module.exports = {
  ...esmConfig,
  entry: "./src/coordinationos-vendor.ts",
  output: {
    ...esmConfig.output,
    filename: "tinycloud-web-sdk-2.11.0-beta.9.mjs",
    path: path.resolve(__dirname, "dist/vendor"),
  },
};
