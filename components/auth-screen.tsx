"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { KapilotoWordmark } from "@/components/kapiloto-wordmark";
import { parseRecoveryIdentifier, passwordValidationError, usernameValidationError } from "@/lib/auth/identity";

export type AuthMode = "login" | "signup" | "recovery" | "reset";

type Props = {
  mode: AuthMode;
  initialNotice?: string | null;
  initialError?: string | null;
};

type ApiError = {
  error?: { code?: string; message?: string };
};

async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: T | ApiError }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  let data: T | ApiError = {};
  try {
    data = (await response.json()) as T | ApiError;
  } catch {
    // Generic UI messaging below handles empty/unparseable responses.
  }

  return { ok: response.ok, status: response.status, data };
}

function AuthHero() {
  return (
    <div className="relative aspect-[390/286] w-full shrink-0 overflow-hidden bg-[#0a1120]">
      <img
        src="/brand/kapiloto-auth-hero.svg"
        alt=""
        loading="eager"
        fetchPriority="high"
        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
      />
      <KapilotoWordmark
        size="hero"
        className="absolute left-1/2 top-[14px] -translate-x-1/2"
      />
      <p
        className="absolute left-1/2 top-[64px] -translate-x-1/2 whitespace-nowrap text-[10.5px] font-semibold text-[#bdc7e5]"
        style={{ fontFamily: "var(--font-rubik), Rubik, sans-serif" }}
      >
        המגרש של הקבוצה שלך
      </p>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[#04060f] to-transparent" />
    </div>
  );
}

function AuthTabs({ mode }: { mode: "login" | "signup" }) {
  return (
    <div
      className="flex h-[42px] w-full gap-1 rounded-[14px] bg-[#0a1120] p-[3px]"
      dir="ltr"
    >
      <Link
        href="/register"
        className={`flex h-9 flex-1 items-center justify-center rounded-[11px] text-[11px] font-bold ${mode === "signup" ? "bg-[#070c17] text-[#f6f9ff]" : "text-[#96a8c9]"}`}
        style={{ fontFamily: "var(--font-rubik), Rubik, sans-serif" }}
        dir="rtl"
      >
        הרשמה
      </Link>
      <Link
        href="/login"
        className={`flex h-9 flex-1 items-center justify-center rounded-[11px] text-[11px] font-bold ${mode === "login" ? "bg-[#070c17] text-[#f6f9ff]" : "text-[#96a8c9]"}`}
        style={{ fontFamily: "var(--font-rubik), Rubik, sans-serif" }}
        dir="rtl"
      >
        התחברות
      </Link>
    </div>
  );
}

function Field({
  label,
  name,
  type = "text",
  autoComplete,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex h-[70px] w-full flex-col gap-1.5">
      <span
        className="text-[10px] font-medium text-[#96a8c9]"
        style={{ fontFamily: "var(--font-rubik), Rubik, sans-serif" }}
      >
        {label}
      </span>
      <input
        name={name}
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-[46px] w-full rounded-[13px] border border-[#1c263c] bg-[#070c17] px-3 text-right text-[12px] font-medium text-[#f6f9ff] outline-none transition-colors placeholder:text-[#96a8c9] focus:border-[#7038fa]"
        style={{ fontFamily: "var(--font-rubik), Rubik, sans-serif" }}
      />
    </label>
  );
}

function PrimaryButton({
  children,
  busy,
}: {
  children: React.ReactNode;
  busy: boolean;
}) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="flex h-12 w-full items-center justify-center rounded-[14px] bg-[#7038fa] text-[12px] font-bold text-white disabled:opacity-60"
      style={{ fontFamily: "var(--font-rubik), Rubik, sans-serif" }}
    >
      {busy ? "רגע…" : children}
    </button>
  );
}

function StatusMessage({
  tone,
  children,
}: {
  tone: "error" | "success";
  children: React.ReactNode;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`w-full text-center text-[9px] ${tone === "error" ? "text-[#eb4266]" : "text-[#14b273]"}`}
      style={{ fontFamily: "var(--font-rubik), Rubik, sans-serif" }}
    >
      {children}
    </p>
  );
}

export function AuthScreen({
  mode,
  initialNotice = null,
  initialError = null,
}: Props) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [recovery, setRecovery] = useState("");
  const [remember, setRemember] = useState(true);
  const [token, setToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [phoneStep, setPhoneStep] = useState<"signup" | "recovery" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(initialNotice);

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await postJson<{ ok: true }>("/api/auth/login", {
      username,
      password,
      remember,
    });
    setBusy(false);

    if (!result.ok) {
      setError(
        result.status === 429
          ? "יותר מדי ניסיונות. נסה שוב בעוד מספר דקות."
          : "שם המשתמש או הסיסמה אינם נכונים.",
      );
      return;
    }

    router.push("/");
    router.refresh();
  }

  async function submitSignup(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    if (usernameValidationError(username)) {
      setError("שם המשתמש חייב להכיל 3–40 תווים ולכלול רק אותיות, מספרים, נקודה, מקף או קו תחתון.");
      return;
    }
    if (passwordValidationError(password)) {
      setError("הסיסמה חייבת להכיל לפחות 8 תווים.");
      return;
    }
    if (!parseRecoveryIdentifier(recovery)) {
      setError("יש להזין כתובת מייל או מספר טלפון תקינים.");
      return;
    }

    setBusy(true);
    const result = await postJson<{
      ok: true;
      channel: "email" | "phone";
      needsVerification: boolean;
      hasSession: boolean;
    }>("/api/auth/register", {
      username,
      password,
      recovery,
    });
    setBusy(false);

    if (!result.ok) {
      if (result.status === 429) {
        setError("יותר מדי ניסיונות. נסה שוב בעוד מספר דקות.");
      } else if (result.status === 409) {
        setError("שם המשתמש אינו זמין.");
      } else {
        setError("לא ניתן ליצור את החשבון כרגע. בדוק את הפרטים ונסה שוב.");
      }
      return;
    }

    const data = result.data as {
      ok: true;
      channel: "email" | "phone";
      needsVerification: boolean;
      hasSession: boolean;
    };

    if (data.hasSession) {
      router.push("/");
      router.refresh();
      return;
    }

    if (data.channel === "phone" && data.needsVerification) {
      setPhoneStep("signup");
      setNotice("נשלח קוד אימות לטלפון. הזן אותו כדי להשלים את ההרשמה.");
      return;
    }

    setNotice("נשלחה הודעת אימות לפרטי השחזור. לאחר האימות ניתן להתחבר.");
  }

  async function verifySignupPhone(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await postJson<{ ok: true }>(
      "/api/auth/register/verify-phone",
      { phone: recovery, token },
    );
    setBusy(false);

    if (!result.ok) {
      setError("הקוד אינו תקין או שפג תוקפו.");
      return;
    }

    router.push("/");
    router.refresh();
  }

  async function submitRecovery(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await postJson<{
      ok: true;
      channel: "email" | "phone";
    }>("/api/auth/recover", { recovery });
    setBusy(false);

    if (!result.ok) {
      setError(
        result.status === 429
          ? "יותר מדי ניסיונות. נסה שוב בעוד מספר דקות."
          : "פרטי השחזור אינם בפורמט תקין.",
      );
      return;
    }

    const data = result.data as { ok: true; channel: "email" | "phone" };
    if (data.channel === "phone") {
      setPhoneStep("recovery");
      setNotice("אם המספר קיים במערכת, נשלח אליו קוד שחזור.");
      return;
    }

    setNotice("אם הפרטים קיימים במערכת, נשלחו אליהם הוראות לשחזור הסיסמה.");
  }

  async function verifyRecoveryPhone(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("הסיסמאות אינן תואמות.");
      return;
    }

    setBusy(true);
    setError(null);
    const result = await postJson<{ ok: true }>(
      "/api/auth/recover/verify-phone",
      {
        phone: recovery,
        token,
        password: newPassword,
      },
    );
    setBusy(false);

    if (!result.ok) {
      setError("לא ניתן להשלים את השחזור. בדוק את הקוד והסיסמה ונסה שוב.");
      return;
    }

    router.push("/login?reset=1");
    router.refresh();
  }

  async function submitReset(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("הסיסמאות אינן תואמות.");
      return;
    }

    setBusy(true);
    setError(null);
    const result = await postJson<{ ok: true }>("/api/auth/password", {
      password: newPassword,
    });
    setBusy(false);

    if (!result.ok) {
      setError("לא ניתן לעדכן את הסיסמה. בקש קישור שחזור חדש.");
      return;
    }

    router.push("/login?reset=1");
    router.refresh();
  }

  const authFont = { fontFamily: "var(--font-rubik), Rubik, sans-serif" };

  return (
    <main
      className="mx-auto flex min-h-dvh w-full max-w-[390px] flex-col bg-[#04060f]"
      dir="rtl"
    >
      <AuthHero />

      {mode === "login" ? (
        <form
          onSubmit={submitLogin}
          className="flex min-h-[584px] flex-1 flex-col gap-3 bg-[#04060f] px-6 pb-[26px] pt-4"
        >
          <AuthTabs mode="login" />
          <Field
            label="שם משתמש"
            name="username"
            autoComplete="username"
            value={username}
            onChange={setUsername}
          />
          <Field
            label="סיסמה"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
          />
          <div className="flex h-7 w-full items-center justify-between" dir="ltr">
            <Link
              href="/recover"
              className="text-[10px] font-medium text-[#7038fa]"
              style={authFont}
              dir="rtl"
            >
              שכחתי סיסמה
            </Link>
            <label
              className="flex items-center gap-[7px] text-[10px] font-medium text-[#f6f9ff]"
              style={authFont}
              dir="rtl"
            >
              זכור אותי
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
                className="size-[18px] accent-[#7038fa]"
              />
            </label>
          </div>
          <PrimaryButton busy={busy}>התחבר</PrimaryButton>
          {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
          {notice ? <StatusMessage tone="success">{notice}</StatusMessage> : null}
          <p className="text-center text-[9px] text-[#96a8c9]" style={authFont}>
            כאשר ״זכור אותי״ מסומן, תישאר מחובר במכשיר הזה עד שתתנתק יזום.
          </p>
        </form>
      ) : null}

      {mode === "signup" ? (
        <form
          onSubmit={phoneStep === "signup" ? verifySignupPhone : submitSignup}
          className="flex min-h-[584px] flex-1 flex-col gap-[9px] bg-[#04060f] px-6 pb-6 pt-[14px]"
        >
          <AuthTabs mode="signup" />
          {phoneStep === "signup" ? (
            <>
              <Field
                label="קוד אימות"
                name="token"
                autoComplete="one-time-code"
                value={token}
                onChange={setToken}
              />
              <PrimaryButton busy={busy}>אמת והשלם הרשמה</PrimaryButton>
            </>
          ) : (
            <>
              <Field
                label="שם משתמש"
                name="username"
                autoComplete="username"
                placeholder="בחר שם משתמש"
                value={username}
                onChange={setUsername}
              />
              <Field
                label="סיסמה"
                name="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={setPassword}
              />
              <Field
                label="מייל או טלפון לשחזור"
                name="recovery"
                autoComplete="email tel"
                placeholder="name@example.com / 05X-XXXXXXX"
                value={recovery}
                onChange={setRecovery}
              />
              <div className="flex h-7 w-full items-center justify-between" dir="ltr">
                <span
                  className="rounded-full bg-[#091b25] px-[9px] py-[5px] text-[9px] font-medium text-[#14ccff]"
                  style={authFont}
                  dir="rtl"
                >
                  אחד מהם מספיק
                </span>
                <span
                  className="text-[9px] text-[#96a8c9]"
                  style={authFont}
                  dir="rtl"
                >
                  פרטי השחזור אינם שם ההתחברות
                </span>
              </div>
              <PrimaryButton busy={busy}>צור חשבון</PrimaryButton>
            </>
          )}
          {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
          {notice ? <StatusMessage tone="success">{notice}</StatusMessage> : null}
          <p
            className="text-center text-[8px] leading-[1.75] text-[#96a8c9]"
            style={authFont}
          >
            במקרה של שכחת סיסמה נשלח קישור או קוד איפוס למייל/טלפון. הסיסמה
            הקיימת עצמה לעולם אינה נשלחת.
          </p>
        </form>
      ) : null}

      {mode === "recovery" ? (
        <form
          onSubmit={
            phoneStep === "recovery"
              ? verifyRecoveryPhone
              : submitRecovery
          }
          className="flex min-h-[584px] flex-1 flex-col gap-[13px] bg-[#04060f] p-6"
        >
          <h1 className="text-[20px] font-bold text-[#f6f9ff]" style={authFont}>
            שחזור סיסמה
          </h1>
          {phoneStep === "recovery" ? (
            <>
              <p className="text-[10px] leading-[1.6] text-[#96a8c9]" style={authFont}>
                הזן את הקוד שנשלח ואת הסיסמה החדשה.
              </p>
              <Field
                label="קוד שחזור"
                name="token"
                autoComplete="one-time-code"
                value={token}
                onChange={setToken}
              />
              <Field
                label="סיסמה חדשה"
                name="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={setNewPassword}
              />
              <Field
                label="אימות סיסמה"
                name="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={setConfirmPassword}
              />
              <PrimaryButton busy={busy}>עדכן סיסמה</PrimaryButton>
            </>
          ) : (
            <>
              <p className="h-[42px] text-[10px] leading-[1.6] text-[#96a8c9]" style={authFont}>
                הזן את המייל או מספר הטלפון שחיברת לחשבון. נשלח לך קישור או קוד
                חד־פעמי להגדרת סיסמה חדשה.
              </p>
              <Field
                label="מייל או טלפון"
                name="recovery"
                autoComplete="email tel"
                placeholder="name@example.com / 05X-XXXXXXX"
                value={recovery}
                onChange={setRecovery}
              />
              <PrimaryButton busy={busy}>שלח קוד שחזור</PrimaryButton>
              <div className="flex h-[102px] flex-col gap-1.5 rounded-2xl border border-[#1c263c] bg-[#070c17] p-3">
                <p className="text-[10px] font-bold text-[#f6f9ff]" style={authFont}>
                  אבטחה
                </p>
                <p className="text-[8px] leading-[1.7] text-[#96a8c9]" style={authFont}>
                  לא נחשוף אם שם משתמש, מייל או מספר טלפון מסוימים קיימים
                  במערכת. הודעות השגיאה יהיו כלליות כדי לצמצם ניסיונות לאיתור
                  חשבונות.
                </p>
              </div>
            </>
          )}
          {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
          {notice ? <StatusMessage tone="success">{notice}</StatusMessage> : null}
        </form>
      ) : null}

      {mode === "reset" ? (
        <form
          onSubmit={submitReset}
          className="flex min-h-[584px] flex-1 flex-col gap-[13px] bg-[#04060f] p-6"
        >
          <h1 className="text-[20px] font-bold text-[#f6f9ff]" style={authFont}>
            הגדרת סיסמה חדשה
          </h1>
          <p className="text-[10px] leading-[1.6] text-[#96a8c9]" style={authFont}>
            בחר סיסמה חדשה לחשבון.
          </p>
          <Field
            label="סיסמה חדשה"
            name="new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={setNewPassword}
          />
          <Field
            label="אימות סיסמה"
            name="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={setConfirmPassword}
          />
          <PrimaryButton busy={busy}>שמור סיסמה</PrimaryButton>
          {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
        </form>
      ) : null}
    </main>
  );
}
