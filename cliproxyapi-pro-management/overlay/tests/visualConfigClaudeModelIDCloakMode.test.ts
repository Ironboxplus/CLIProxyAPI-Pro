import { describe, expect, test } from 'bun:test';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse as parseYaml } from 'yaml';
import {
  parseClaudeModelIDCloakMode,
  useVisualConfig,
} from '../src/hooks/useVisualConfig';

describe('visual config Claude model ID cloak mode', () => {
  test('normalizes unsupported values to auto', () => {
    expect(parseClaudeModelIDCloakMode(undefined)).toBe('auto');
    expect(parseClaudeModelIDCloakMode('unsupported')).toBe('auto');
    expect(parseClaudeModelIDCloakMode('ALWAYS')).toBe('always');
    expect(parseClaudeModelIDCloakMode('never')).toBe('never');
  });

  test('loads and writes the selected mode', () => {
    function Harness() {
      const visualConfig = useVisualConfig();
      const [phase, setPhase] = useState(0);

      if (phase === 0) {
        visualConfig.loadVisualValuesFromYaml('claude-model-id-cloak-mode: auto\n');
        setPhase(1);
      } else if (phase === 1) {
        visualConfig.setVisualValues({ claudeModelIDCloakMode: 'never' });
        setPhase(2);
      } else {
        return createElement(
          'pre',
          null,
          visualConfig.applyVisualChangesToYaml('claude-model-id-cloak-mode: auto\n')
        );
      }

      return null;
    }

    const markup = renderToStaticMarkup(createElement(Harness));
    const result = markup.slice('<pre>'.length, -'</pre>'.length);

    expect(parseYaml(result)).toEqual({ 'claude-model-id-cloak-mode': 'never' });
  });
});
