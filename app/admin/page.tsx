import { redirect } from "next/navigation";
import { getCurrentRole } from "@/lib/auth/roles";
import { AdminPage } from "./AdminPage";

export default async function Page() {
  const role = await getCurrentRole();
  if (role !== "admin") redirect("/");
  return <AdminPage />;
}
