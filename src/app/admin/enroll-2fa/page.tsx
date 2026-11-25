import { EnrollTwoFactorForm } from "./enroll-form";

export default function Enroll2FA() {
  return (
    <EnrollTwoFactorForm
      intro="Required for all platform administrators. Confirm your password to start."
      doneHref="/admin"
      back={{ href: "/admin/sign-in", label: "Back to sign in" }}
    />
  );
}
