import { redirect } from "next/navigation";
import Link from "next/link";
import { Wallet } from "lucide-react";
import { getCurrentSession } from "@/domain/auth";
import { Card } from "@/components/ui/card";
import { SignupForm } from "./signup-form";

export default async function SignupPage() {
  if (await getCurrentSession()) redirect("/dashboard");

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-[var(--radius)] bg-primary/15 text-primary">
            <Wallet size={20} strokeWidth={2.25} />
          </span>
          <div>
            <p className="text-lg font-semibold leading-tight">Moni</p>
            <p className="text-xs text-muted-foreground">Your money, in focus.</p>
          </div>
        </div>
        <Card>
          <div className="p-6">
            <h1 className="mb-1 text-xl font-semibold">Create your account</h1>
            <p className="mb-5 text-sm text-muted-foreground">
              Set a password to encrypt your finances. You&apos;ll need an invite token from whoever
              runs this Moni instance.
            </p>
            <SignupForm />
          </div>
        </Card>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="text-primary hover:underline">
            Log in
          </Link>
        </p>
      </div>
    </main>
  );
}
