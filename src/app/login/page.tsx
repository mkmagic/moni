import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentSession } from "@/domain/auth";
import { Card } from "@/components/ui/card";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  if (await getCurrentSession()) redirect("/dashboard");

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element -- next/image's optimizer proxies through a mocked internal request with no Host header, which src/proxy.ts's HTTPS-only gate rejects */}
          <img src="/moni-icon.png" alt="" className="h-11 w-auto" />
          <div>
            <p className="text-lg font-semibold leading-tight">Moni</p>
            <p className="text-xs text-muted-foreground">Your money, in focus.</p>
          </div>
        </div>
        <Card>
          <div className="p-6">
            <h1 className="mb-1 text-xl font-semibold">Welcome back</h1>
            <p className="mb-5 text-sm text-muted-foreground">
              Enter your password to unlock and decrypt your finances for this session.
            </p>
            <LoginForm />
          </div>
        </Card>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="text-primary hover:underline">
            Sign up
          </Link>
        </p>
      </div>
    </main>
  );
}
