/**
 * Match these with the versions in the meteor-typescript/package.js
 */
const METEOR3_BETA_VERSION = "-beta.4";
const COMPILER_VERSION = `0.4.0-meteor3${METEOR3_BETA_VERSION}`;
const TYPESCRIPT_VERSION = "5.3.2";

Package.describe({
  name: "refapp:meteor-typescript-compiler",
  version: COMPILER_VERSION,
  summary: "A Typescript compiler plugin for Meteor",
  git: "https://github.com/Meteor-Community-Packages/meteor-typescript-compiler",
  documentation: "README.md",
});

Npm.depends({
  "typescript": TYPESCRIPT_VERSION,
  "chalk": "4.0.0",
  "@types/node": "14.0.4",
});

Package.onUse(function (api) {
  api.versionsFrom(["2.12", `3.0${METEOR3_BETA_VERSION}`]);
  api.use(["babel-compiler"], "server");
  // For compiling this package.
  // Typescript itself does not use semver so the meteor package should *not* follow typescript’s version
  // but I’ve been unable to persuade the core meteor team not to unnecessarily break code that works...
  // Add a few years of updates here until typescript 8.x appears :)
  api.use(["typescript@3.0.0||4.0.0||5.0.0||6.0.0||7.0.0"], "server");
  api.addFiles(["meteor-typescript-compiler.ts"], "server");
  api.export(["MeteorTypescriptCompiler"], "server");
});

Package.onTest(function (api) {
  api.use("tinytest");
  api.use("typescript");
  api.use("refapp:meteor-typescript-compiler");
  api.mainModule("tests.ts");
});
