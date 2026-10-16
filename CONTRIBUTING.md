# Contributing

Use Node 22+ and npm. Run `npm ci` and `npm run check` before each push. Install the local pre-push gate with `git config core.hooksPath .githooks`. Tests must use fictional fixtures and targets. Keep actual inventories, hostnames, credentials, local reports and `.npmrc` files outside this repository. Preserve the documented JSON schema 2 and TSV contracts; version and document breaking output changes.

Releases use `npm run check`, `npm pack`, a reviewed public tarball, and an authenticated `npm publish --access public`. Registry credentials must stay outside the checkout. Attach the same tarball and its SHA256SUMS to a matching GitHub tag. Never claim standalone binaries, Homebrew support or registry availability without verifying them.
