# Changelog

## [0.2.0](https://github.com/metaneutrons/HASI/compare/v0.1.0...v0.2.0) (2026-10-18)


### Features

* **anny:** support confirmed cancellation and focused office search ([#40](https://github.com/metaneutrons/HASI/issues/40)) ([171f457](https://github.com/metaneutrons/HASI/commit/171f4579c9b1ed37d336e930af0dbc59bfabd144))
* **chat:** add discreet copy actions for individual messages ([#42](https://github.com/metaneutrons/HASI/issues/42)) ([75a555b](https://github.com/metaneutrons/HASI/commit/75a555b1e624d42337abe22f851a0ce668ec05e0))
* **chat:** verify message times and default new chats to Groq ([#31](https://github.com/metaneutrons/HASI/issues/31)) ([e25ceec](https://github.com/metaneutrons/HASI/commit/e25ceec24562c6f732fb0e337d6fe8b4f6009e3e))
* connect Groq chat to validated anny demo tools ([#5](https://github.com/metaneutrons/HASI/issues/5)) ([ed4d2d0](https://github.com/metaneutrons/HASI/commit/ed4d2d0e42c10b6ad597614b1cd4f5c215404e03))
* **delivery:** add Release Please containers and automatic demo delivery ([#20](https://github.com/metaneutrons/HASI/issues/20)) ([ababcc9](https://github.com/metaneutrons/HASI/commit/ababcc9b6ad5ae89ebfdbf603ddd4b3435689211))
* **demo:** run durable API and MCP tools on Vercel ([#12](https://github.com/metaneutrons/HASI/issues/12)) ([22180ec](https://github.com/metaneutrons/HASI/commit/22180ec4bddace1c0cc9c9342b0d893eff02bb8e))
* **knowledge:** connect demo MCP sources and room catalog ([#13](https://github.com/metaneutrons/HASI/issues/13)) ([319ac13](https://github.com/metaneutrons/HASI/commit/319ac132181ae64f37960b7e9953652fbe31e904))
* **models:** add GWDG and custom OpenAI-compatible providers ([#19](https://github.com/metaneutrons/HASI/issues/19)) ([489de2c](https://github.com/metaneutrons/HASI/commit/489de2c6e20cbc9ea06bc3708506e0b999ce2c4b))
* **models:** configure providers and policy-controlled chat routing ([#35](https://github.com/metaneutrons/HASI/issues/35)) ([c072962](https://github.com/metaneutrons/HASI/commit/c072962719097efc71d67b618c4b16d7e2a581db))
* publish HASI prototype with a public browser demo ([38cb0b3](https://github.com/metaneutrons/HASI/commit/38cb0b327aeede8bf616e64eb0b6580d31b3eb54))
* support independent persistent chat sessions ([#7](https://github.com/metaneutrons/HASI/issues/7)) ([c78a02d](https://github.com/metaneutrons/HASI/commit/c78a02dee4f95ac1785fd74209eab68949fe8543))


### Bug Fixes

* **anny:** allow rebooking cancelled mock intervals ([#44](https://github.com/metaneutrons/HASI/issues/44)) ([b20d8fd](https://github.com/metaneutrons/HASI/commit/b20d8fd0e0601e262d9cf4b5d1a5fc2bcc89a600))
* **anny:** book individual workplaces within offices ([#28](https://github.com/metaneutrons/HASI/issues/28)) ([213192c](https://github.com/metaneutrons/HASI/commit/213192cca4e00b4d340de0ed2ed4bd74c0e584ee))
* **anny:** preserve office links and workplace location filters ([#29](https://github.com/metaneutrons/HASI/issues/29)) ([28933e7](https://github.com/metaneutrons/HASI/commit/28933e725a108feb444176aafc2f83c71b516884))
* **chat:** anchor relative dates to the Berlin calendar ([#30](https://github.com/metaneutrons/HASI/issues/30)) ([63a7075](https://github.com/metaneutrons/HASI/commit/63a7075c062f0f87780da0d99cddef430eeaf353))
* **chat:** match building searches and preserve requested workplace times ([#36](https://github.com/metaneutrons/HASI/issues/36)) ([3fb240a](https://github.com/metaneutrons/HASI/commit/3fb240ad6b46a53e6944dd24e11e7156b5141942))
* **chat:** present session actions in floating menus and dialogs ([#39](https://github.com/metaneutrons/HASI/issues/39)) ([ec5cd66](https://github.com/metaneutrons/HASI/commit/ec5cd663800362bfcf18bf8b7eee6cdf9bdd399b))
* **chat:** preserve requested booking times and clarify cancellation actions ([#41](https://github.com/metaneutrons/HASI/issues/41)) ([d09bb8d](https://github.com/metaneutrons/HASI/commit/d09bb8d52d442996402b6bf3748b4f6b0da55e45))
* **chat:** reduce Groq context and redundant planning calls ([#43](https://github.com/metaneutrons/HASI/issues/43)) ([25586c1](https://github.com/metaneutrons/HASI/commit/25586c1c462e0cd826a8a7fdb9f4e0eb05d4db73))
* **chat:** reuse unused conversations before creating another ([#38](https://github.com/metaneutrons/HASI/issues/38)) ([f059916](https://github.com/metaneutrons/HASI/commit/f059916fe1282f6c3b529d0213a7ad5bf3339f4a))
* **delivery:** generate correctly sized smoke secrets ([#24](https://github.com/metaneutrons/HASI/issues/24)) ([d8f8d8b](https://github.com/metaneutrons/HASI/commit/d8f8d8b2663bb719d052471972ea837e4614e0bd))
* **delivery:** generate SBOM from the qualified OCI archive ([#25](https://github.com/metaneutrons/HASI/issues/25)) ([58479f9](https://github.com/metaneutrons/HASI/commit/58479f9caf45fc84f92fdee8ad6a0e01df2262d0))
* **delivery:** retry early container socket closures ([#23](https://github.com/metaneutrons/HASI/issues/23)) ([e2d13ad](https://github.com/metaneutrons/HASI/commit/e2d13adeefb0ec9bedb4142ff90a1e5e43a002b6))
* **delivery:** select built-in provenance attestations ([#27](https://github.com/metaneutrons/HASI/issues/27)) ([c4fc4ee](https://github.com/metaneutrons/HASI/commit/c4fc4ee8a46506e2555458f203ca3e3f8cf969fb))
* diagnose native Groq tool-call failures safely ([#8](https://github.com/metaneutrons/HASI/issues/8)) ([545145a](https://github.com/metaneutrons/HASI/commit/545145a5f19af7e01fda55d1f7e7a458c71f7a65))
* keep mobile controls visible and bound Groq tool loops ([#6](https://github.com/metaneutrons/HASI/issues/6)) ([3ec4a90](https://github.com/metaneutrons/HASI/commit/3ec4a9078bf0da9a50b6b9ca19fdfa49bad3fe5b))
* make the assistant conversation the primary interface ([#4](https://github.com/metaneutrons/HASI/issues/4)) ([17f9322](https://github.com/metaneutrons/HASI/commit/17f9322af94bfb807c3fed39eece7aef5e768195))
* repair the mobile sign-in layout above 420px ([#10](https://github.com/metaneutrons/HASI/issues/10)) ([40431b1](https://github.com/metaneutrons/HASI/commit/40431b1bebc50d2d9ccf09e2e69f289d1ba77c8e))
* stabilize Groq tool calls and add Qwen comparison ([#9](https://github.com/metaneutrons/HASI/issues/9)) ([fd7855d](https://github.com/metaneutrons/HASI/commit/fd7855d64d66755b4a85ef1183ba6883839e5c3d))
* **web:** keep chat and administration usable on phones ([#11](https://github.com/metaneutrons/HASI/issues/11)) ([23eb39c](https://github.com/metaneutrons/HASI/commit/23eb39ca246b9ef76cc924ecddf7bc0001baa60e))
