/** RQ-TERM-2: environment-activation text typed by other extensions is never forwarded to the board. Pure. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACTIVATION_WINDOW_MS, ActivationInputFilter, looksLikeActivation } from '../../src/repl/inputFilter';

const TRICKY = '/Users/student/Library/CloudStorage/OneDrive-Example University(email.example.edu)/Lab Course (Fall)/Lab 1';

const POSITIVE: [shell: string, sample: string][] = [
  ['zsh', 'source /Users/student/proj/.venv/bin/activate\r'],
  ['zsh', `source "${TRICKY}/.venv/bin/activate"\r`],
  ['zsh', `. '${TRICKY}/.venv/bin/activate'\r`],
  ['bash', 'source ~/.virtualenvs/lab/bin/activate\r'],
  ['bash', '. /home/s/proj/venv/bin/activate\n'],
  ['bash', 'source activate base\r'],
  ['bash (conda)', 'source /opt/miniconda3/bin/activate base\r'],
  ['fish', 'source /home/s/proj/.venv/bin/activate.fish\r'],
  ['cmd', 'C:\\Users\\student\\proj\\.venv\\Scripts\\activate.bat\r'],
  ['cmd', '"C:\\Users\\Student Name\\OneDrive - Example University\\Lab Course (Fall)\\Lab 1\\.venv\\Scripts\\activate.bat"\r'],
  ['cmd', 'call .venv\\Scripts\\activate.bat\r'],
  ['cmd', '.venv\\Scripts\\activate\r'],
  ['cmd', 'activate.bat\r'],
  ['PowerShell', '& "C:\\Users\\Student Name\\proj\\.venv\\Scripts\\Activate.ps1"\r'],
  ['PowerShell', "& 'c:\\proj\\.venv\\Scripts\\Activate.ps1'\r"],
  ['PowerShell', '.\\.venv\\Scripts\\Activate.ps1\r'],
  ['PowerShell', 'Activate.ps1\r'],
  ['conda', 'conda activate base\r'],
  ['conda', 'conda activate "C:\\Users\\student\\miniconda3\\envs\\lab"\r'],
  ['conda', 'C:\\Users\\student\\miniconda3\\Scripts\\conda.exe activate base\r'],
  ['conda', 'micromamba activate lab\r'],
  ['two lines in one chunk', 'source /p/.venv/bin/activate\rconda activate base\r'],
];

const NEGATIVE: string[] = [
  'print("activate")\r',
  'def activate(self):\r',
  'x = activate\r',
  'activate_motor()\r',
  'import activate\r',
  'source = a/activate\r',
  'motor.activate(1)\r',
  'a',
  '\x03',
  '\x1b[A',
  '',
  'source /p/.venv/bin/activate\rprint(1)\r',
];

describe('looksLikeActivation', () => {
  for (const [shell, sample] of POSITIVE) {
    it(`recognises ${shell}: ${JSON.stringify(sample).slice(0, 70)}`, () => {
      assert.equal(looksLikeActivation(sample), true);
    });
  }
  for (const sample of NEGATIVE) {
    it(`does not mistake ${JSON.stringify(sample)} for activation`, () => {
      assert.equal(looksLikeActivation(sample), false);
    });
  }
});

describe('ActivationInputFilter', () => {
  it('drops an activation chunk in the first 10 s before any keystroke, forwards everything else', () => {
    let t = 1000;
    const f = new ActivationInputFilter({ now: () => t });
    t += 500;
    assert.equal(f.accept('source /x/.venv/bin/activate\r'), false);
    assert.equal(f.accept('conda activate base\r'), false, 'a second activation line is dropped too while the user has not typed');
    assert.equal(f.userHasTyped, false);
    assert.equal(f.accept('1'), true);
    assert.equal(f.userHasTyped, true);
  });

  it('lets real Python code that mentions activate through after the first keystroke', () => {
    const f = new ActivationInputFilter({ now: () => 0 });
    assert.equal(f.accept('p'), true);
    assert.equal(f.accept('source /x/.venv/bin/activate\r'), true, 'after the first keystroke nothing is filtered');
    assert.equal(f.accept('def activate(self): pass\r'), true);
    assert.equal(f.accept('print("activate")\r'), true);
  });

  it('ordinary code is forwarded even as the very first chunk, and closes the window', () => {
    const f = new ActivationInputFilter({ now: () => 0 });
    assert.equal(f.accept('print("activate")\r'), true);
    assert.equal(f.accept('source /x/.venv/bin/activate\r'), true);
  });

  it('stops filtering after the window (10 s by default)', () => {
    let t = 0;
    const f = new ActivationInputFilter({ now: () => t });
    t = ACTIVATION_WINDOW_MS;
    assert.equal(f.accept('source /x/bin/activate\r'), false, 'still inside the window at exactly 10 s');
    t = ACTIVATION_WINDOW_MS + 1;
    assert.equal(f.accept('source /x/bin/activate\r'), true);
  });
});
