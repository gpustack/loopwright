import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertNoSymlinkAncestors,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_RELAY_HOST,
  loadRelayConfig,
  loadWorkerConfig,
  MAX_RUNNER_CONFIG_BYTES,
  MAX_SECRET_LENGTH,
  normalizeRelayServerConfig,
  parseRelayConfigObject,
  parseStrictJsonBytes,
  parseWorkerConfigObject,
  resolveEnvSecretRef,
  toNullPrototypeValue,
} from '../src/config.js';
import { HardwareRunnerError } from '../src/types.js';

const TEST_ENV: Readonly<Record<string, string>> = Object.freeze({
  LW_RELAY_SIGNING_SECRET: 'relay-hmac-signing-secret-0123456789abcdef',
  LW_CONTROLLER_BEARER: 'controller-bearer-token-abcdef0123456789',
  LW_WORKER_TOKEN_1: 'worker-bearer-token-one-0123456789abcdef',
  LW_WORKER_TOKEN_2: 'worker-bearer-token-two-0123456789abcdef',
  LW_SHORT_SECRET: 'tiny123',
});

function assertConfigInvalid(fn: () => unknown, check?: (err: HardwareRunnerError) => void): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof HardwareRunnerError);
    assert.equal(err.code, 'CONFIG_INVALID');
    check?.(err);
    return true;
  });
}

async function assertAsyncConfigInvalid(
  fn: () => Promise<unknown>,
  check?: (err: HardwareRunnerError) => void,
): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof HardwareRunnerError);
    assert.equal(err.code, 'CONFIG_INVALID');
    check?.(err);
    return true;
  });
}

test('loadRelayConfig loads valid YAML and JSON configs and resolves env: secret refs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-hw-config-relay-'));
  try {
    const yamlPath = join(dir, 'relay.yaml');
    await writeFile(
      yamlPath,
      [
        'kind: relay',
        'host: 0.0.0.0',
        'port: 0',
        'casDir: ./cas-store',
        'signingSecretEnv: env:LW_RELAY_SIGNING_SECRET',
        'controllerAuthTokenEnv: LW_CONTROLLER_BEARER',
        'workerTokenEnvs:',
        '  - LW_WORKER_TOKEN_1',
        '  - env:LW_WORKER_TOKEN_2',
        'leaseTtlMs: 15000',
        'sweepIntervalMs: 1000',
        'verdictTtlMs: 60000',
        'maxBlobBytes: 10485760',
        'maxJobs: 64',
        'tls:',
        '  certPath: ./certs/server.crt',
        '  keyPath: ./certs/server.key',
        '  caPath: ./certs/ca.crt',
        '',
      ].join('\n'),
      'utf8',
    );

    const yamlCfg = await loadRelayConfig(yamlPath, { env: TEST_ENV });
    assert.ok(Object.isFrozen(yamlCfg));
    assert.equal(yamlCfg.host, '0.0.0.0');
    assert.equal(yamlCfg.port, 0);
    assert.equal(yamlCfg.casDir, join(dir, 'cas-store'));
    assert.equal(yamlCfg.controllerSigningSecret, TEST_ENV.LW_RELAY_SIGNING_SECRET);
    assert.equal(yamlCfg.controllerAuthToken, TEST_ENV.LW_CONTROLLER_BEARER);
    assert.deepEqual(yamlCfg.workerTokens, [TEST_ENV.LW_WORKER_TOKEN_1, TEST_ENV.LW_WORKER_TOKEN_2]);
    assert.equal(yamlCfg.leaseTtlMs, 15_000);
    assert.equal(yamlCfg.sweepIntervalMs, 1_000);
    assert.equal(yamlCfg.verdictTtlMs, 60_000);
    assert.equal(yamlCfg.maxBlobBytes, 10_485_760);
    assert.equal(yamlCfg.maxJobs, 64);
    assert.notEqual(yamlCfg.tls, false);
    if (yamlCfg.tls !== false) {
      assert.equal(yamlCfg.tls.certPath, join(dir, 'certs', 'server.crt'));
      assert.equal(yamlCfg.tls.keyPath, join(dir, 'certs', 'server.key'));
      assert.equal(yamlCfg.tls.caPath, join(dir, 'certs', 'ca.crt'));
    }

    const jsonPath = join(dir, 'relay.json');
    await writeFile(
      jsonPath,
      JSON.stringify({
        port: 8443,
        casDir: join(dir, 'json-cas'),
        signingSecretEnv: 'LW_RELAY_SIGNING_SECRET',
        workerTokenEnv: 'LW_WORKER_TOKEN_1',
        tls: false,
      }),
      'utf8',
    );
    const jsonCfg = await loadRelayConfig(jsonPath, { env: TEST_ENV });
    assert.equal(jsonCfg.host, DEFAULT_RELAY_HOST);
    assert.equal(jsonCfg.port, 8443);
    assert.equal(jsonCfg.leaseTtlMs, DEFAULT_LEASE_TTL_MS);
    assert.equal(jsonCfg.tls, false);
    assert.equal(Object.hasOwn(jsonCfg, 'controllerAuthToken'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadWorkerConfig loads valid YAML and JSON configs for native_os and docker backends', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-hw-config-worker-'));
  try {
    const toolchainRoot = join(dir, 'toolchain');
    const yamlPath = join(dir, 'worker.yaml');
    await writeFile(
      yamlPath,
      [
        'kind: worker',
        'workerId: gpu-worker-01',
        'relayUrl: https://relay.internal:9443/',
        'workerTokenEnv: env:LW_WORKER_TOKEN_1',
        'workDir: ./scratch',
        'heldOutWorkloadsDir: ./held-out',
        'sandboxBackend: docker',
        'dockerImage: nvcr.io/nvidia/cuda:12.6.0-devel-ubuntu24.04',
        'capabilities:',
        '  accelerator: sm_90a',
        '  isolationModes:',
        '    - whole_device',
        '    - sliced',
        '  deviceCount: 4',
        '  driverVersion: "550.90.07"',
        '  topology: nvlink_4x',
        '  workloadIds:',
        '    - gemm-fp8-v1',
        '    - flash-attn-v3',
        'pollWaitMs: 12000',
        'heartbeatIntervalMs: 4000',
        'requestTimeoutMs: 20000',
        'stageATimeoutMs: 120000',
        'stageBTimeoutMs: 180000',
        'toolchainPaths:',
        `  - ${toolchainRoot}`,
        'probeMode: synthetic_fixture',
        'tlsCaPath: ./certs/ca.pem',
        '',
      ].join('\n'),
      'utf8',
    );

    const cfg = await loadWorkerConfig(yamlPath, { env: TEST_ENV });
    assert.equal(cfg.workerId, 'gpu-worker-01');
    assert.equal(cfg.relayUrl, 'https://relay.internal:9443');
    assert.equal(cfg.workerToken, TEST_ENV.LW_WORKER_TOKEN_1);
    assert.equal(cfg.workDir, join(dir, 'scratch'));
    assert.equal(cfg.heldOutWorkloadsDir, join(dir, 'held-out'));
    assert.equal(cfg.sandboxBackend, 'docker');
    assert.equal(cfg.dockerImage, 'nvcr.io/nvidia/cuda:12.6.0-devel-ubuntu24.04');
    assert.equal(cfg.capabilities.accelerator, 'sm_90a');
    assert.deepEqual(cfg.capabilities.isolationModes, ['whole_device', 'sliced']);
    assert.equal(cfg.capabilities.deviceCount, 4);
    assert.equal(cfg.capabilities.driverVersion, '550.90.07');
    assert.equal(cfg.capabilities.topology, 'nvlink_4x');
    assert.deepEqual(cfg.capabilities.workloadIds, ['gemm-fp8-v1', 'flash-attn-v3']);
    assert.deepEqual(cfg.toolchainPaths, [toolchainRoot]);
    assert.equal(cfg.probeMode, 'synthetic_fixture');
    assert.equal(cfg.tlsCaPath, join(dir, 'certs', 'ca.pem'));

    const jsonPath = join(dir, 'worker.json');
    await writeFile(
      jsonPath,
      JSON.stringify({
        workerId: 'rocm-worker-02',
        relayUrl: 'http://127.0.0.1:18080/prefix/',
        workerTokenEnv: 'LW_WORKER_TOKEN_2',
        workDir: './w',
        heldOutWorkloadsDir: './h',
        capabilities: {
          accelerator: 'gfx1101',
          isolationModes: ['whole_device'],
          deviceCount: 1,
          driverVersion: '6.2.0',
        },
      }),
      'utf8',
    );
    const jsonCfg = await loadWorkerConfig(jsonPath, { env: TEST_ENV });
    assert.equal(jsonCfg.relayUrl, 'http://127.0.0.1:18080/prefix');
    assert.equal(jsonCfg.sandboxBackend, 'native_os');
    assert.equal(jsonCfg.probeMode, 'physical');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('config loader rejects symlinked files, symlinked ancestor directories, and oversized files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-hw-config-symlink-'));
  try {
    const realDir = join(dir, 'real');
    await mkdir(realDir);
    const realConfig = join(realDir, 'relay.yaml');
    await writeFile(
      realConfig,
      'port: 0\ncasDir: ./cas\nsigningSecretEnv: LW_RELAY_SIGNING_SECRET\nworkerTokenEnv: LW_WORKER_TOKEN_1\n',
      'utf8',
    );

    const fileLink = join(dir, 'symlink-relay.yaml');
    await symlink(realConfig, fileLink);
    await assertAsyncConfigInvalid(() => loadRelayConfig(fileLink, { env: TEST_ENV }));

    const dirLink = join(dir, 'linked-dir');
    await symlink(realDir, dirLink);
    await assertAsyncConfigInvalid(() => loadRelayConfig(join(dirLink, 'relay.yaml'), { env: TEST_ENV }));

    const oversizedPath = join(dir, 'huge.yaml');
    const pad = 'a'.repeat(MAX_RUNNER_CONFIG_BYTES + 128);
    await writeFile(oversizedPath, `# ${pad}\nport: 0\n`, 'utf8');
    await assertAsyncConfigInvalid(() => loadRelayConfig(oversizedPath, { env: TEST_ENV }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('config parser rejects unknown keys, -0, lone UTF-16 surrogates, and invalid port/URL/token refs without leaking secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-hw-config-neg-'));
  try {
    // Unknown keys at root and nested levels
    assertConfigInvalid(() =>
      parseRelayConfigObject(
        {
          port: 0,
          casDir: '/tmp/cas',
          signingSecretEnv: 'LW_RELAY_SIGNING_SECRET',
          workerTokenEnv: 'LW_WORKER_TOKEN_1',
          unexpectedKey: true,
        },
        { env: TEST_ENV },
      ),
    );
    assertConfigInvalid(() =>
      parseWorkerConfigObject(
        {
          workerId: 'w1',
          relayUrl: 'http://127.0.0.1:8080',
          workerTokenEnv: 'LW_WORKER_TOKEN_1',
          workDir: '/tmp/work',
          heldOutWorkloadsDir: '/tmp/held',
          capabilities: {
            accelerator: 'sm_89',
            isolationModes: ['whole_device'],
            deviceCount: 1,
            driverVersion: '535.104.05',
            extraCap: 1,
          },
        },
        { env: TEST_ENV },
      ),
    );

    // -0 rejection in JS objects, JSON files, and YAML files
    assertConfigInvalid(() =>
      parseRelayConfigObject(
        {
          port: -0,
          casDir: '/tmp/cas',
          signingSecretEnv: 'LW_RELAY_SIGNING_SECRET',
          workerTokenEnv: 'LW_WORKER_TOKEN_1',
        },
        { env: TEST_ENV },
      ),
    );

    const negZeroJson = join(dir, 'neg-zero.json');
    await writeFile(
      negZeroJson,
      '{"port": -0, "casDir": "./cas", "signingSecretEnv": "LW_RELAY_SIGNING_SECRET", "workerTokenEnv": "LW_WORKER_TOKEN_1"}',
      'utf8',
    );
    await assertAsyncConfigInvalid(() => loadRelayConfig(negZeroJson, { env: TEST_ENV }));

    const negZeroYaml = join(dir, 'neg-zero.yaml');
    await writeFile(
      negZeroYaml,
      'port: -0\ncasDir: ./cas\nsigningSecretEnv: LW_RELAY_SIGNING_SECRET\nworkerTokenEnv: LW_WORKER_TOKEN_1\n',
      'utf8',
    );
    await assertAsyncConfigInvalid(() => loadRelayConfig(negZeroYaml, { env: TEST_ENV }));

    // Lone UTF-16 surrogates (escaped in JSON and raw in JS object)
    const surrogateJson = join(dir, 'surrogate.json');
    await writeFile(
      surrogateJson,
      '{"port": 0, "casDir": "./cas\\uD800bad", "signingSecretEnv": "LW_RELAY_SIGNING_SECRET", "workerTokenEnv": "LW_WORKER_TOKEN_1"}',
      'utf8',
    );
    await assertAsyncConfigInvalid(() => loadRelayConfig(surrogateJson, { env: TEST_ENV }));

    assertConfigInvalid(() =>
      parseRelayConfigObject(
        {
          port: 0,
          casDir: '/tmp/cas\uDC00',
          signingSecretEnv: 'LW_RELAY_SIGNING_SECRET',
          workerTokenEnv: 'LW_WORKER_TOKEN_1',
        },
        { env: TEST_ENV },
      ),
    );

    // Invalid ports
    for (const badPort of [-1, 65536, 8080.5, Number.NaN]) {
      assertConfigInvalid(() =>
        parseRelayConfigObject(
          {
            port: badPort,
            casDir: '/tmp/cas',
            signingSecretEnv: 'LW_RELAY_SIGNING_SECRET',
            workerTokenEnv: 'LW_WORKER_TOKEN_1',
          },
          { env: TEST_ENV },
        ),
      );
    }

    // Invalid relay URLs
    for (const badUrl of [
      'ftp://127.0.0.1:8080',
      'ws://127.0.0.1:8080',
      'http://user:pass@127.0.0.1:8080',
      'http://127.0.0.1:8080?token=leak',
      'http://127.0.0.1:8080#frag',
      'not-a-url',
    ]) {
      assertConfigInvalid(() =>
        parseWorkerConfigObject(
          {
            workerId: 'w1',
            relayUrl: badUrl,
            workerTokenEnv: 'LW_WORKER_TOKEN_1',
            workDir: '/tmp/work',
            heldOutWorkloadsDir: '/tmp/held',
            capabilities: {
              accelerator: 'sm_89',
              isolationModes: ['whole_device'],
              deviceCount: 1,
              driverVersion: '535.104.05',
            },
          },
          { env: TEST_ENV },
        ),
      );
    }

    // Invalid / missing / short / colliding secret env refs (and never leak secret values in error messages)
    for (const badRef of ['inline-secret-value-1234', 'file:/etc/passwd', 'env:lowercase_bad', 'MISSING_ENV_VAR', 'LW_SHORT_SECRET']) {
      assertConfigInvalid(
        () =>
          parseRelayConfigObject(
            {
              port: 0,
              casDir: '/tmp/cas',
              signingSecretEnv: badRef,
              workerTokenEnv: 'LW_WORKER_TOKEN_1',
            },
            { env: TEST_ENV },
          ),
        err => {
          assert.equal(err.message.includes(TEST_ENV.LW_SHORT_SECRET!), false);
          assert.equal(err.message.includes(TEST_ENV.LW_WORKER_TOKEN_1!), false);
        },
      );
    }

    // Worker token must never share the controller HMAC signing secret
    assertConfigInvalid(() =>
      parseRelayConfigObject(
        {
          port: 0,
          casDir: '/tmp/cas',
          signingSecretEnv: 'LW_RELAY_SIGNING_SECRET',
          workerTokenEnv: 'LW_RELAY_SIGNING_SECRET',
        },
        { env: TEST_ENV },
      ),
    );

    // Docker backend requires dockerImage; workDir and heldOutWorkloadsDir must be disjoint
    assertConfigInvalid(() =>
      parseWorkerConfigObject(
        {
          workerId: 'w1',
          relayUrl: 'http://127.0.0.1:8080',
          workerTokenEnv: 'LW_WORKER_TOKEN_1',
          workDir: '/tmp/work',
          heldOutWorkloadsDir: '/tmp/held',
          sandboxBackend: 'docker',
          capabilities: {
            accelerator: 'sm_89',
            isolationModes: ['whole_device'],
            deviceCount: 1,
            driverVersion: '535.104.05',
          },
        },
        { env: TEST_ENV },
      ),
    );
    assertConfigInvalid(() =>
      parseWorkerConfigObject(
        {
          workerId: 'w1',
          relayUrl: 'http://127.0.0.1:8080',
          workerTokenEnv: 'LW_WORKER_TOKEN_1',
          workDir: '/tmp/shared',
          heldOutWorkloadsDir: '/tmp/shared/nested',
          capabilities: {
            accelerator: 'sm_89',
            isolationModes: ['whole_device'],
            deviceCount: 1,
            driverVersion: '535.104.05',
          },
        },
        { env: TEST_ENV },
      ),
    );

    // Duplicate isolationModes, duplicate workloadIds, missing worker tokens, malformed YAML/JSON, and normalizeRelayServerConfig
    assertConfigInvalid(() =>
      parseWorkerConfigObject(
        {
          workerId: 'w1',
          relayUrl: 'http://127.0.0.1:8080',
          workerTokenEnv: 'LW_WORKER_TOKEN_1',
          workDir: '/tmp/work',
          heldOutWorkloadsDir: '/tmp/held',
          capabilities: {
            accelerator: 'sm_89',
            isolationModes: ['whole_device', 'whole_device'],
            deviceCount: 1,
            driverVersion: '535.104.05',
          },
        },
        { env: TEST_ENV },
      ),
    );
    assertConfigInvalid(() =>
      parseWorkerConfigObject(
        {
          workerId: 'w1',
          relayUrl: 'http://127.0.0.1:8080',
          workerTokenEnv: 'LW_WORKER_TOKEN_1',
          workDir: '/tmp/work',
          heldOutWorkloadsDir: '/tmp/held',
          capabilities: {
            accelerator: 'sm_89',
            isolationModes: ['whole_device'],
            deviceCount: 1,
            driverVersion: '535.104.05',
            workloadIds: ['dup-id', 'dup-id'],
          },
        },
        { env: TEST_ENV },
      ),
    );
    assertConfigInvalid(() =>
      parseRelayConfigObject(
        {
          port: 0,
          casDir: '/tmp/cas',
          signingSecretEnv: 'LW_RELAY_SIGNING_SECRET',
        },
        { env: TEST_ENV },
      ),
    );

    const badYaml = join(dir, 'malformed.yaml');
    await writeFile(badYaml, 'port: [unclosed\n', 'utf8');
    await assertAsyncConfigInvalid(() => loadWorkerConfig(badYaml, { env: TEST_ENV }));

    const badJson = join(dir, 'malformed.json');
    await writeFile(badJson, '{"a": 1, "a": 2}', 'utf8');
    await assertAsyncConfigInvalid(() => loadWorkerConfig(badJson, { env: TEST_ENV }));

    // Invalid maxBytes, non-UTF8 bytes, proxy/getter/symbol/prototype-key rejection, and normalizeRelayServerConfig guards
    await assertAsyncConfigInvalid(() => loadRelayConfig(badJson, { env: TEST_ENV, maxBytes: 0 }));
    await assertAsyncConfigInvalid(() => loadWorkerConfig(badJson, { env: TEST_ENV, maxBytes: MAX_RUNNER_CONFIG_BYTES + 1 }));
    assertConfigInvalid(() => parseStrictJsonBytes(new Uint8Array([0xff, 0xfe]), 64, 'CONFIG_INVALID', '/'));
    assertConfigInvalid(() => toNullPrototypeValue(new Proxy({}, {}), 'CONFIG_INVALID', '/'));
    assertConfigInvalid(() => toNullPrototypeValue({ [Symbol('s')]: 1 }, 'CONFIG_INVALID', '/'));
    const getterTrap: Record<string, unknown> = {};
    Object.defineProperty(getterTrap, 'port', { enumerable: true, get: () => 8080 });
    assertConfigInvalid(() => toNullPrototypeValue(getterTrap, 'CONFIG_INVALID', '/'));
    const protoTrap = Object.create(null) as Record<string, unknown>;
    protoTrap['prototype'] = {};
    assertConfigInvalid(() => toNullPrototypeValue(protoTrap, 'CONFIG_INVALID', '/'));

    const normalizedSrv = normalizeRelayServerConfig({
      host: '127.0.0.1',
      port: 0,
      casDir: join(dir, 'norm-cas'),
      controllerSigningSecret: TEST_ENV.LW_RELAY_SIGNING_SECRET!,
      controllerAuthToken: TEST_ENV.LW_CONTROLLER_BEARER!,
      workerTokens: [TEST_ENV.LW_WORKER_TOKEN_1!],
      leaseTtlMs: 5_000,
      sweepIntervalMs: 250,
      verdictTtlMs: 10_000,
      maxBlobBytes: 4_096,
      maxJobs: 16,
      maxRetainedTerminalOps: 8,
    });
    assert.equal(normalizedSrv.maxJobs, 16);
    assert.equal(normalizedSrv.maxRetainedTerminalOps, 8);
    assertConfigInvalid(() =>
      normalizeRelayServerConfig({
        port: 0,
        casDir: join(dir, 'norm-cas'),
        controllerSigningSecret: TEST_ENV.LW_RELAY_SIGNING_SECRET!,
        workerTokens: [TEST_ENV.LW_WORKER_TOKEN_1!],
        maxRetainedTerminalOps: 0,
      }),
    );
    assertConfigInvalid(() =>
      normalizeRelayServerConfig({
        port: 0,
        casDir: 'relative/not-allowed',
        controllerSigningSecret: TEST_ENV.LW_RELAY_SIGNING_SECRET!,
        workerTokens: [TEST_ENV.LW_WORKER_TOKEN_1!],
      }),
    );
    assertConfigInvalid(() =>
      normalizeRelayServerConfig({
        port: 0,
        casDir: join(dir, 'norm-cas'),
        controllerSigningSecret: TEST_ENV.LW_RELAY_SIGNING_SECRET!,
        workerTokens: [],
      }),
    );

    // Schema boundary coverage for kind, sandboxBackend, probeMode, toolchainPaths, missing fields, and non-object roots
    assertConfigInvalid(() => parseRelayConfigObject(null, { env: TEST_ENV }));
    assertConfigInvalid(() => parseRelayConfigObject({}, { env: TEST_ENV }));
    assertConfigInvalid(() =>
      parseRelayConfigObject(
        {
          kind: 'worker',
          port: 0,
          casDir: '/tmp/cas',
          signingSecretEnv: 'LW_RELAY_SIGNING_SECRET',
          workerTokenEnv: 'LW_WORKER_TOKEN_1',
        },
        { env: TEST_ENV },
      ),
    );
    const validWorkerBase = {
      workerId: 'w1',
      relayUrl: 'http://127.0.0.1:8080',
      workerTokenEnv: 'LW_WORKER_TOKEN_1',
      workDir: '/tmp/work',
      heldOutWorkloadsDir: '/tmp/held',
      capabilities: {
        accelerator: 'sm_89',
        isolationModes: ['whole_device'],
        deviceCount: 1,
        driverVersion: '535.104.05',
      },
    };
    for (const badPatch of [
      { kind: 'relay' },
      { workerId: 'bad space' },
      { sandboxBackend: 'podman' },
      { probeMode: 'emulated' },
      { toolchainPaths: ['relative/toolchain'] },
      { capabilities: { ...validWorkerBase.capabilities, isolationModes: ['invalid'] } },
      { capabilities: { ...validWorkerBase.capabilities, workloadIds: ['bad/slash'] } },
    ]) {
      assertConfigInvalid(() => parseWorkerConfigObject({ ...validWorkerBase, ...badPatch }, { env: TEST_ENV }));
    }

    // Inherited prototype uppercase keys on env map MUST NEVER resolve credentials
    const inheritedProto = {
      LW_INHERITED_SECRET: 'inherited-prototype-secret-0123456789abcdef',
    };
    const envWithInherited = Object.assign(
      Object.create(inheritedProto) as Record<string, string | undefined>,
      { LW_OWN_WORKER_TOKEN: TEST_ENV.LW_WORKER_TOKEN_1 },
    );
    assertConfigInvalid(
      () => resolveEnvSecretRef('LW_INHERITED_SECRET', envWithInherited, '/signingSecretEnv'),
      err => {
        assert.equal(err.message.includes(inheritedProto.LW_INHERITED_SECRET), false);
      },
    );
    assertConfigInvalid(() =>
      parseRelayConfigObject(
        {
          port: 0,
          casDir: '/tmp/cas',
          signingSecretEnv: 'LW_INHERITED_SECRET',
          workerTokenEnv: 'LW_OWN_WORKER_TOKEN',
        },
        { env: envWithInherited },
      ),
    );
    assertConfigInvalid(() =>
      parseWorkerConfigObject(
        {
          ...validWorkerBase,
          workerTokenEnv: 'env:LW_INHERITED_SECRET',
        },
        { env: envWithInherited },
      ),
    );

    // Credential length upper bound (MAX_SECRET_LENGTH = 4096 passes; 4097 fails closed)
    const maxLenEnv = {
      LW_MAX_OK: 'k'.repeat(MAX_SECRET_LENGTH),
      LW_TOO_LONG: 'x'.repeat(MAX_SECRET_LENGTH + 1),
      LW_WORKER_OK: TEST_ENV.LW_WORKER_TOKEN_1!,
    };
    assert.equal(resolveEnvSecretRef('LW_MAX_OK', maxLenEnv, '/signingSecretEnv').length, MAX_SECRET_LENGTH);
    assertConfigInvalid(() => resolveEnvSecretRef('LW_TOO_LONG', maxLenEnv, '/signingSecretEnv'));
    assertConfigInvalid(() =>
      normalizeRelayServerConfig({
        port: 0,
        casDir: join(dir, 'norm-cas'),
        controllerSigningSecret: 'x'.repeat(MAX_SECRET_LENGTH + 1),
        workerTokens: [TEST_ENV.LW_WORKER_TOKEN_1!],
      }),
    );

    // Non-directory ancestor file is rejected by assertNoSymlinkAncestors
    const regularAncestorFile = join(dir, 'not-a-dir');
    await writeFile(regularAncestorFile, 'file', 'utf8');
    await assertAsyncConfigInvalid(() =>
      assertNoSymlinkAncestors(join(regularAncestorFile, 'child', 'cas'), { checkLeaf: true }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
