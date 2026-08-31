# Canonical DSH Creator export

Use UTF-8 JSON with these required fields:

- format: dsh-creator-export
- schemaVersion: 1
- sourceFingerprint: a sha256 value over the normalized export without this field
- name: portable kebab-case plugin and skill name
- packageName: lowercase npm package name
- author and one-line description
- goal and instructions
- compatibilityTarget: 0.1.1-rc.2

The optional arrays decisions and unresolvedRisks contain unique strings. The optional arrays tools and resources contain objects with a kebab-case name and a purpose. These are preserved as explicitly labelled implementation intentions in the generated skill; the current release does not create native tools or resource files from them. Unknown fields are rejected so an exporter cannot silently lose intent.

Creator should emit the fingerprint. While developing an exporter, calculate the expected value without mutating the draft:

    node bin/dsh-developer.js fingerprint --source <creator-draft.json>

Pass --json to receive the complete normalized export with sourceFingerprint. Promotion re-reads a stable ordinary file, rejects concurrent mutation and potential credentials, and verifies the fingerprint before any output is created.

The output directory basename must exactly equal name. packageName may differ because it is the npm identity used for DSH uninstall.
