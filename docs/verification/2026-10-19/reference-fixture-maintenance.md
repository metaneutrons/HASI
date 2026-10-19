# Deterministic foreign-repository isolation fixture

Date: 2026-10-19. Repair baseline: `20bd019e79098bea2c5e10a8b36a29fdeb9afdcc`.

Main CI `39250342628`, Node 24 job `118052307839`, failed the reference-plugin
isolation test after the PR's exact-head checks had passed. The complete foreign
repository snapshots differed only by `.git/objects/maintenance.lock`: the
baseline contained the empty mode-0644 lock, and the final snapshot did not.
The hosted job reported Git 2.55.0. This is evidence of an asynchronous fixture
mutation, not evidence that the qualifier changed a foreign source or index.
The failed main commit was not deployed; the prior verified application remained
ready at `204630145653ac07ac0ea0daa376dd07217d6fcf`.

The disposable foreign repository now sets `maintenance.auto=false` and
`gc.auto=0` before its first commit, preventing that fixture from launching
background maintenance after the snapshot. These are local fixture settings;
the user's repository/global configuration and qualification tool are unchanged.
All directories, modes, symlinks, file contents, index and repository objects
remain in the exact before/after comparison. No lock path is ignored, no
assertion is weakened, and no sleep or retry is used to manufacture a pass.

The existing test still exercises poisoned inherited Git directory, worktree,
index, global/config-count and template settings, then verifies both the complete
foreign tree and restoration of inherited settings. Local focused and required
CI results belong to the exact repair head; a successful rerun of an unrelated
commit would not establish this source repair. This fixes test determinism only,
not the remaining independent-distribution/M2 qualification.
