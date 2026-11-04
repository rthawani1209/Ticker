import { SessionProvider } from "@/components/session/SessionProvider";

// Signed-in screens share one session, so moving between them doesn't sign you out.
export default function AppLayout({ children }: LayoutProps<"/">) {
  return <SessionProvider>{children}</SessionProvider>;
}
