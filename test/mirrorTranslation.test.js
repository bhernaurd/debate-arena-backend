import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MIRROR_ANALYSIS_TRANSLATION_VERSION,
    mergeTranslatedMirrorAnalysis,
    normalizeMirrorLanguageCode,
} from '../lib/mirrorAnthropicService.js';

test('normalizes supported Mirror language codes', () => {
    assert.equal(normalizeMirrorLanguageCode('pt_BR'), 'pt-BR');
    assert.equal(normalizeMirrorLanguageCode('ZH-HANS'), 'zh-Hans');
    assert.equal(normalizeMirrorLanguageCode('es'), 'es');
    assert.equal(normalizeMirrorLanguageCode('unsupported'), 'en');
    assert.equal(MIRROR_ANALYSIS_TRANSLATION_VERSION, 'mirror-analysis-translation-v1');
});

test('translation merge changes prose but preserves protocol fields and array shape', () => {
    const source = {
        schemaVersion: 'mirror-analysis-v7',
        summary: { headline: 'Open to revision', overview: 'Original overview.' },
        reflection: 'Original reflection.',
        archetypeAnalysis: { summary: 'Original archetype.', changeExplanation: null },
        dimensions: [
            {
                dimension: 'autonomy_obligation',
                interpretation: 'Original dimension.',
                changeExplanation: null,
                evidenceRelationship: 'questionnaire_only',
            },
        ],
        meaningfulChanges: [{ title: 'Original title', explanation: 'Original explanation' }],
        stablePatterns: [],
        questionnaireDebateAgreements: [],
        tensions: [],
        reconsideredBeliefs: [],
        philosophicalConnections: [
            { philosopher: 'Socrates', connection: 'Original connection', difference: 'Original difference' },
        ],
        evidenceBreadthInterpretation: 'Original breadth.',
        nextQuestions: [{ question: 'Original question?', reason: 'Original reason' }],
        recommendations: [
            {
                targetId: 'target-1',
                kind: 'topic',
                title: 'Original recommendation',
                philosopher: 'Plato',
                topic: 'Original topic?',
                reason: 'Original recommendation reason',
            },
        ],
    };

    const translated = {
        schemaVersion: 'WRONG',
        summary: { headline: 'Aberto à revisão', overview: 'Resumo traduzido.' },
        reflection: 'Análise traduzida.',
        archetypeAnalysis: { summary: 'Arquétipo traduzido.', changeExplanation: 'Should not replace null.' },
        dimensions: [
            {
                dimension: 'autonomy_obligation',
                interpretation: 'Dimensão traduzida.',
                changeExplanation: 'Should not replace null.',
                evidenceRelationship: 'WRONG',
            },
        ],
        meaningfulChanges: [{ title: 'Título traduzido', explanation: 'Explicação traduzida' }],
        philosophicalConnections: [
            { philosopher: 'WRONG', connection: 'Conexão traduzida', difference: 'Diferença traduzida' },
        ],
        evidenceBreadthInterpretation: 'Amplitude traduzida.',
        nextQuestions: [{ question: 'Pergunta traduzida?', reason: 'Motivo traduzido' }],
        recommendations: [
            {
                targetId: 'target-1',
                kind: 'WRONG',
                title: 'Recomendação traduzida',
                philosopher: 'WRONG',
                topic: 'Tópico traduzido?',
                reason: 'Motivo da recomendação traduzido',
            },
        ],
    };

    const result = mergeTranslatedMirrorAnalysis(source, translated);

    assert.equal(result.schemaVersion, 'mirror-analysis-v7');
    assert.equal(result.summary.headline, 'Aberto à revisão');
    assert.equal(result.reflection, 'Análise traduzida.');
    assert.equal(result.dimensions.length, 1);
    assert.equal(result.dimensions[0].dimension, 'autonomy_obligation');
    assert.equal(result.dimensions[0].evidenceRelationship, 'questionnaire_only');
    assert.equal(result.dimensions[0].interpretation, 'Dimensão traduzida.');
    assert.equal(result.dimensions[0].changeExplanation, null);
    assert.equal(result.philosophicalConnections[0].philosopher, 'Socrates');
    assert.equal(result.recommendations[0].targetId, 'target-1');
    assert.equal(result.recommendations[0].kind, 'topic');
    assert.equal(result.recommendations[0].philosopher, 'Plato');
    assert.equal(result.recommendations[0].topic, 'Tópico traduzido?');
    assert.equal(result.meaningfulChanges.length, 1);
    assert.deepEqual(result.stablePatterns, []);
});
