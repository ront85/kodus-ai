import {
    canProceedWithBusinessRulesAnalysis,
    getTaskContextMissingInfoMessage,
    normalizeTaskQuality,
    TASK_QUALITY_ANALYZER_POLICY,
} from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/task-quality.rules';

describe('task-quality.rules', () => {
    it('allows analysis only for PARTIAL and COMPLETE', () => {
        expect(canProceedWithBusinessRulesAnalysis('PARTIAL')).toBe(true);
        expect(canProceedWithBusinessRulesAnalysis('COMPLETE')).toBe(true);
        expect(canProceedWithBusinessRulesAnalysis('EMPTY')).toBe(false);
        expect(canProceedWithBusinessRulesAnalysis('MINIMAL')).toBe(false);
    });

    it('normalizes unknown values to EMPTY', () => {
        expect(normalizeTaskQuality('COMPLETE')).toBe('COMPLETE');
        expect(normalizeTaskQuality('invalid')).toBe('EMPTY');
        expect(normalizeTaskQuality(undefined)).toBe('EMPTY');
    });

    it('returns specific missing-info message based on task quality', () => {
        expect(getTaskContextMissingInfoMessage('EMPTY')).toContain(
            '## 🤔 Need Task Information',
        );
        expect(getTaskContextMissingInfoMessage('MINIMAL')).toContain(
            '## 🤔 Insufficient Task Context',
        );
    });

    it('exposes a canonical analyzer policy for task quality behavior', () => {
        expect(TASK_QUALITY_ANALYZER_POLICY).toContain(
            'EMPTY => needsMoreInfo = true',
        );
        expect(TASK_QUALITY_ANALYZER_POLICY).toContain(
            'PARTIAL => proceed with full gap analysis',
        );
    });
});
