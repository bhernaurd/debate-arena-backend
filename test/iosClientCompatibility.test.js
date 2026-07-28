import test from 'node:test';
import assert from 'node:assert/strict';

import {
    compareIosVersions,
    evaluateMinimumIosClient,
    parseOptionalIosVersion,
    parseOptionalPositiveInteger,
} from '../lib/iosClientCompatibility.js';

test('parses and normalizes valid iOS versions', () => {
    assert.equal(parseOptionalIosVersion('3.8.0')?.normalized, '3.8');
    assert.equal(parseOptionalIosVersion('10.0.1')?.normalized, '10.0.1');
});

test('rejects malformed iOS versions', () => {
    assert.equal(parseOptionalIosVersion('version 3.8'), null);
    assert.equal(parseOptionalIosVersion('3..8'), null);
    assert.equal(parseOptionalIosVersion('3.8.1.2.3'), null);
});

test('parses only safe positive integers', () => {
    assert.equal(parseOptionalPositiveInteger('16'), 16);
    assert.equal(parseOptionalPositiveInteger(22), 22);
    assert.equal(parseOptionalPositiveInteger('1e2'), null);
    assert.equal(parseOptionalPositiveInteger('1.5'), null);
    assert.equal(parseOptionalPositiveInteger('0'), null);
});

test('compares marketing versions numerically', () => {
    assert.equal(compareIosVersions('3.8', '3.7'), 1);
    assert.equal(compareIosVersions('3.8', '3.8.0'), 0);
    assert.equal(compareIosVersions('10.0', '9.9'), 1);
    assert.equal(compareIosVersions('3.7.9', '3.8'), -1);
});

const dostoevskyMinimum = {
    minimumVersion: '3.7',
    minimumBuild: 16,
    minimumLegacyBuild: 16,
};

test('blocks 3.7 build 15', () => {
    const result = evaluateMinimumIosClient({
        clientVersion: '3.7',
        clientBuild: 15,
        ...dostoevskyMinimum,
    });

    assert.equal(result.satisfied, false);
    assert.equal(result.reason, 'client_build_too_old');
});

test('allows 3.7 build 16', () => {
    const result = evaluateMinimumIosClient({
        clientVersion: '3.7',
        clientBuild: 16,
        ...dostoevskyMinimum,
    });

    assert.equal(result.satisfied, true);
    assert.equal(result.reason, 'client_build_satisfied');
});

test('allows 3.7 build 22', () => {
    const result = evaluateMinimumIosClient({
        clientVersion: '3.7',
        clientBuild: 22,
        ...dostoevskyMinimum,
    });

    assert.equal(result.satisfied, true);
});

test('allows newer version 3.8 build 1', () => {
    const result = evaluateMinimumIosClient({
        clientVersion: '3.8',
        clientBuild: 1,
        ...dostoevskyMinimum,
    });

    assert.equal(result.satisfied, true);
    assert.equal(result.reason, 'client_version_newer');
});

test('blocks older version even with a higher build number', () => {
    const result = evaluateMinimumIosClient({
        clientVersion: '3.6',
        clientBuild: 100,
        ...dostoevskyMinimum,
    });

    assert.equal(result.satisfied, false);
    assert.equal(result.reason, 'client_version_too_old');
});

test('allows a legacy client at the explicit legacy threshold', () => {
    const result = evaluateMinimumIosClient({
        clientBuild: 16,
        ...dostoevskyMinimum,
    });

    assert.equal(result.satisfied, true);
    assert.equal(result.comparisonMode, 'legacy_build');
});

test('blocks a legacy client below the explicit legacy threshold', () => {
    const result = evaluateMinimumIosClient({
        clientBuild: 15,
        ...dostoevskyMinimum,
    });

    assert.equal(result.satisfied, false);
    assert.equal(result.reason, 'legacy_build_too_old');
});

test('blocks legacy clients when no legacy threshold is configured', () => {
    const result = evaluateMinimumIosClient({
        clientBuild: 22,
        minimumVersion: '4.0',
        minimumBuild: 1,
        minimumLegacyBuild: null,
    });

    assert.equal(result.satisfied, false);
    assert.equal(result.reason, 'legacy_client_not_supported');
});

test('supports existing build-only release rows', () => {
    const allowed = evaluateMinimumIosClient({
        clientBuild: 22,
        minimumBuild: 16,
    });

    const blocked = evaluateMinimumIosClient({
        clientBuild: 15,
        minimumBuild: 16,
    });

    assert.equal(allowed.satisfied, true);
    assert.equal(blocked.satisfied, false);
});

test('allows releases with no minimum requirement', () => {
    const result = evaluateMinimumIosClient({});

    assert.equal(result.satisfied, true);
    assert.equal(result.reason, 'no_minimum_requirement');
});

test('fails closed for malformed client metadata', () => {
    const invalidVersion = evaluateMinimumIosClient({
        clientVersion: '3.x',
        clientBuild: 22,
        ...dostoevskyMinimum,
    });

    const invalidBuild = evaluateMinimumIosClient({
        clientVersion: '3.7',
        clientBuild: '1e2',
        ...dostoevskyMinimum,
    });

    assert.equal(invalidVersion.satisfied, false);
    assert.equal(invalidVersion.reason, 'invalid_client_version');
    assert.equal(invalidBuild.satisfied, false);
    assert.equal(invalidBuild.reason, 'invalid_client_build');
});

test('fails closed for invalid minimum configuration', () => {
    const result = evaluateMinimumIosClient({
        clientVersion: '3.8',
        clientBuild: 1,
        minimumVersion: 'version 3.7',
        minimumBuild: 16,
    });

    assert.equal(result.satisfied, false);
    assert.equal(result.reason, 'invalid_minimum_configuration');
});


test('rejects a malformed build even when the marketing version is newer', () => {
    const result = evaluateMinimumIosClient({
        clientVersion: '3.8',
        clientBuild: '1e2',
        ...dostoevskyMinimum,
    });

    assert.equal(result.satisfied, false);
    assert.equal(result.reason, 'invalid_client_build');
});
