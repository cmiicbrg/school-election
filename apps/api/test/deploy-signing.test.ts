// The release's signature as a host verifies it: the public key the
// repository ships is a key cosign can verify with, the host's policy
// requires it for the two images of the app and nothing else, podman is
// told to fetch signatures from ghcr.io, and the publish workflow signs
// with the matching secrets in the form podman reads, then pulls both
// images with podman under exactly these files.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (file: string) => readFile(path.join(root, file), 'utf8')

const IMAGES = ['ghcr.io/cmiicbrg/school-election', 'ghcr.io/cmiicbrg/school-election-postgres']

test('deploy/cosign.pub is an elliptic-curve public key in PEM, as cosign generates it', async () => {
  const pem = await read('deploy/cosign.pub')
  assert.match(pem, /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$/)
  const key = createPublicKey(pem)
  assert.equal(key.type, 'public')
  assert.equal(key.asymmetricKeyType, 'ec')
  assert.equal(key.asymmetricKeyDetails?.namedCurve, 'prime256v1')
})

test('the policy requires that key for both images, and leaves every other image as it is', async () => {
  const policy = JSON.parse(await read('deploy/policy.json')) as {
    default: { type: string }[]
    transports: { docker: Record<string, { type: string, keyPath?: string, signedIdentity?: { type: string } }[]> }
  }
  assert.deepEqual(policy.default, [{ type: 'insecureAcceptAnything' }])
  assert.deepEqual(Object.keys(policy.transports.docker).sort(), IMAGES)
  for (const image of IMAGES) {
    const [requirement, ...rest] = policy.transports.docker[image] ?? []
    assert.deepEqual(rest, [], image)
    assert.equal(requirement?.type, 'sigstoreSigned', image)
    assert.match(requirement?.keyPath ?? '', /\/school-election\/cosign\.pub$/, image)
    assert.deepEqual(requirement?.signedIdentity, { type: 'matchRepository' }, image)
  }
})

test('podman fetches sigstore signatures from ghcr.io', async () => {
  const registries = await read('deploy/registries.d/ghcr.yaml')
  assert.match(registries, /^docker:\n\s+ghcr\.io:\n\s+use-sigstore-attachments: true$/m)
})

test('the publish workflow signs every manifest of both images with the secrets, in the form podman reads', async () => {
  const workflow = await read('.github/workflows/publish-image.yml')
  assert.match(workflow, /COSIGN_PRIVATE_KEY: \$\{\{ secrets\.COSIGN_PRIVATE_KEY \}\}/)
  assert.match(workflow, /COSIGN_PASSWORD: \$\{\{ secrets\.COSIGN_PASSWORD \}\}/)
  // An index's signature alone, or a cosign 3 bundle, verifies with cosign
  // and is refused by podman: "A signature was required, but no signature
  // exists".
  const sign = /cosign sign --yes --recursive --new-bundle-format=false --use-signing-config=false \\\n\s+--key env:\/\/COSIGN_PRIVATE_KEY "\$image"/
  assert.match(workflow, sign)
})

test('the publish workflow pulls both images with the podman of the units, under the files a host installs', async () => {
  const workflow = await read('.github/workflows/publish-image.yml')
  const ci = await read('.github/workflows/ci.yml')
  const podman = /quay\.io\/podman\/stable:v[\d.]+@sha256:[0-9a-f]{64}/
  assert.equal(workflow.match(podman)?.[0], ci.match(podman)?.[0], 'the same podman as the Quadlet check')
  const policy = JSON.parse(await read('deploy/policy.json')) as {
    transports: { docker: Record<string, { keyPath: string }[]> }
  }
  const keyPaths = new Set(Object.values(policy.transports.docker).flat().map((requirement) => requirement.keyPath))
  assert.equal(keyPaths.size, 1)
  assert.ok(workflow.includes(`cp /deploy/cosign.pub ${[...keyPaths][0]}\n`), 'the key where the policy names it')
  assert.ok(workflow.includes('cp /deploy/policy.json /etc/containers/policy.json\n'))
  assert.ok(workflow.includes('cp /deploy/registries.d/ghcr.yaml /etc/containers/registries.d/ghcr.yaml\n'))
  assert.match(workflow, /for image in "\$APP" "\$POSTGRES"; do\n\s+podman --storage-driver vfs pull --quiet "\$image"/)
  assert.doesNotMatch(workflow, /^\s+cosign verify /m, 'cosign verify passes signatures podman refuses')
})
