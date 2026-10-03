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
- voting keys reaching logs, a server-visible URL, an export or the audit log, or anyone but the election's owner and co-admins (witnesses only once the batch's round has closed). Keys are stored as generated, so sheets can be printed again; that storage alone is not a vulnerability;
- voting without a valid credential, voting twice in one contest, or voting outside the open phase of a round;
- results or candidate totals visible before a round is closed;
- bypassing authentication or authorization for administrators and witnesses, including access to another teacher's election;
- weaknesses in credential generation.

Out of scope:

- an operator with root access to the running server who modifies the application or inspects its memory while voting is in progress; the threat model assumes the live server runs the deployed software unmodified;
- denial of service through traffic volume;
- the physical process at the polling place, such as how voting slips are handed out;
- findings that require an outdated browser or a compromised voter device.
