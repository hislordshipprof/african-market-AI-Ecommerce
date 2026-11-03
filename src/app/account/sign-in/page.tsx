import { CustomerSignIn } from "@/components/storefront/customer-sign-in";
import { smsEnabled } from "@/lib/auth";

export default function SignInPage() {
  return <CustomerSignIn smsEnabled={smsEnabled} />;
}
