import { useState } from 'react';
import type { FormEvent } from 'react';
import type { StandController } from '../stand';

export function LoginForm({ controller, error }: { controller: StandController; error: string | null }) {
  // Логин/пароль не предзаполняются: пароли тестовых учёток не должны попадать в production-бандл
  // (§1.6; см. packages/client/src/config.ts). Оболочка измерений входит через ?autologin=&pass=.
  const [loginName, setLoginName] = useState(import.meta.env.DEV ? 'alice' : '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await controller.login(loginName, password);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="login" data-testid="login-form" onSubmit={(e) => void submit(e)}>
      <h1>Вход</h1>
      <label>
        Логин
        <input name="login" value={loginName} autoComplete="username" onChange={(e) => setLoginName(e.target.value)} />
      </label>
      <label>
        Пароль
        <input
          name="password"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error ? (
        <div className="error" data-testid="login-error">
          {error}
        </div>
      ) : null}
      <button type="submit" disabled={busy} data-action="login">
        Войти
      </button>
      <p className="muted">
        Тестовые учётные записи стенда — в `docs/PASSPORT.md`; в сборку клиента пароли не входят. Токен хранится только в памяти.
      </p>
    </form>
  );
}
