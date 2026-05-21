import { redirect } from "next/navigation";
import { SANDBOX_PROVIDERS } from "@/lib/sandbox-types";

export default function Page() {
  redirect(`/${SANDBOX_PROVIDERS[0]}`);
}
