import { getDb } from '@/lib/db';
import { labPin } from '@/lib/lab';
import { SecretSwitch } from './SecretSwitch';

/**
 * Reads the pin server-side and hands it to the client half. Same shape as SpendSlot,
 * and for the same reason: the login page is public and must not open the database.
 */
export function LabSlot() {
  try {
    return <SecretSwitch pin={labPin(getDb())} />;
  } catch {
    // The chrome renders with or without a database. Losing the badge is survivable;
    // an unusable header is not.
    return null;
  }
}
