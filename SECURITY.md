# Security policy

This software runs secret ballots in schools. A flaw that lets someone link a ballot to a voter, vote twice or read results early is serious even if it looks small. Thank you for reporting it privately.

## Reporting a vulnerability

Please do **not** open a public issue, discussion or pull request for a security problem.

Report it through GitHub's private vulnerability reporting: on the repository's **Security** tab, choose **Report a vulnerability**. If that is not possible for you, email <christoph.stadlbauer@brgenns.ac.at>.

Include what you can of the following:

- what an attacker can achieve, and under which role (anonymous voter, witness, teacher, administrator, someone with a database dump);
- steps to reproduce, or a proof of concept;
- the version or commit you tested.

This is a small project maintained in spare time. You can expect an acknowledgement within a week. We will keep you informed while we work on a fix, agree a disclosure date with you, and credit you in the advisory unless you prefer otherwise.

## Supported versions

Until the first release, only the `main` branch is supported. After that, security fixes go into the latest release only.

## Scope

In scope, among others:

- anything that links a ballot to the credential that cast it, or links ballots in different contests to each other, through the database, exports, backups or logs;
- voting keys reaching logs, a server-visible URL, an export or the audit log, or a batch's keys reaching anyone but the election's owner and co-admins (witnesses only once the batch's round has closed). A voter holding the key on the card they drew is how voting works, and keys are stored as generated so that sheets can be printed again; neither is a vulnerability;
- voting without a valid credential, voting twice in one contest, or voting outside the open phase of a round;
- results or candidate totals visible before a round is closed;
- bypassing authentication or authorization for administrators and witnesses, including access to another teacher's election;
- weaknesses in credential generation.

Out of scope:

- an operator with root access to the running server who modifies the application or inspects its memory while voting is in progress; the threat model assumes the live server runs the deployed software unmodified;
- denial of service through traffic volume;
- the physical process at the polling place, such as how voting slips are handed out;
- findings that require an outdated browser or a compromised voter device.

## Residual risks

The privacy model ([`docs/privacy-model.md`](docs/privacy-model.md)) removes what PostgreSQL itself records about a vote: the seal at every round's close and the clean-up at finalization take the transaction ids, the physical order, the dead row versions and the write-ahead log of the votes out of the data directory, and the server refuses to start with settings that would keep, archive, recycle or stream that log. What it does not cover, by design:

- deleted files and segments stay recoverable by disk forensics until the file system overwrites them;
- a backup, a dump with system columns, or a snapshot of the volume or the machine taken between the opening of the first round and finalization holds the pre-seal pages and the write-ahead log, which is why the operator guide keeps every backup and snapshot out of that window;
- a root on the running server or a superuser on the database can read the staged ballots while a round is open;
- under a path of a host it shares (`PUBLIC_URL` with a path), the app's defence against cross-site requests trusts the whole origin, so a page of another site on that host could send requests with a signed-in teacher's cookies; a host of its own keeps that boundary;
- a deployment updates itself from the images this repository publishes and verifies their signature, so what runs at a school is what the release workflow signed; the signing key is a secret of this repository, and whoever controls the repository's GitHub account controls what every school runs the next night. The signature protects against a stolen package-write token and against a registry serving something else, not against that account.

A way to link ballots to keys, or to each other, that does not need one of these is in scope; please report it.
