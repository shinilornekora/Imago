/**
 * Круг 50 (SPEC §17.2): настройки живого дизайна — командами оболочки: «/образ выкл»,
 * «выключи самопроверку», «/шрифты из сети»; без слова — спросить, как сейчас.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as SHELL from '../src/shell.js';

const intent = (s) => SHELL.shellIntent(s, {});

test('круг50: слэш-формы настроек агента', () => {
  assert.deepEqual(intent('/образ выкл'), { kind: 'agent-setting', what: 'direction', on: false });
  assert.deepEqual(intent('/образ'), { kind: 'agent-setting', what: 'direction', on: null });
  assert.deepEqual(intent('/самопроверка вкл'), { kind: 'agent-setting', what: 'critic', on: true });
  assert.deepEqual(intent('/шрифты из сети выкл'), { kind: 'agent-setting', what: 'webFonts', on: false });
  assert.deepEqual(intent('/web fonts on'), { kind: 'agent-setting', what: 'webFonts', on: true });
  assert.deepEqual(intent('/шрифты выкл'), { kind: 'agent-setting', what: 'webFonts', on: false });
  const bad = intent('/образ может быть');
  assert.ok(bad && bad.kind !== 'agent-setting', 'непонятное слово — честная ошибка набора');
});

test('круг50: фразы — только целиком', () => {
  assert.deepEqual(intent('выключи арт-направление'), { kind: 'agent-setting', what: 'direction', on: false });
  assert.deepEqual(intent('включи самопроверку'), { kind: 'agent-setting', what: 'critic', on: true });
  assert.deepEqual(intent('собирай без образа'), { kind: 'agent-setting', what: 'direction', on: false });
  assert.deepEqual(intent('не грузи шрифты из сети'), { kind: 'agent-setting', what: 'webFonts', on: false });
  assert.deepEqual(intent('верни шрифты из сети'), { kind: 'agent-setting', what: 'webFonts', on: true });
  assert.deepEqual(intent('собирай с образом'), { kind: 'agent-setting', what: 'direction', on: true });
  assert.deepEqual(intent('проверяй себя'), { kind: 'agent-setting', what: 'critic', on: true });
  assert.deepEqual(intent('грузи шрифты из сети'), { kind: 'agent-setting', what: 'webFonts', on: true });
  assert.deepEqual(intent('выключи веб шрифты'), { kind: 'agent-setting', what: 'webFonts', on: false });
  assert.equal((intent('собери без образа') || {}).kind === 'agent-setting', false, 'разовая форма — не настройка');
  for (const said of ['выключи образ на кнопке', 'сделай образ ярче', 'шрифты из сети красивые']) {
    const got = intent(said);
    assert.ok(!got || got.kind !== 'agent-setting', said);
  }
  assert.equal(SHELL.isShellCommandText('выключи самопроверку'), true);
});
