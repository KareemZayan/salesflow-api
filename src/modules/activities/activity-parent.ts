// The four records that own a timeline. An activity is linked to one of them by a real foreign key
// (no polymorphic string), so the database keeps every link inside the organization.
export type ActivityParentKind = 'lead' | 'deal' | 'contact' | 'company';

export interface ActivityParent {
  kind: ActivityParentKind;
  id: string;
}

const COLUMN = {
  lead: 'leadId',
  deal: 'dealId',
  contact: 'contactId',
  company: 'companyId',
} as const satisfies Record<ActivityParentKind, string>;

type ParentWhere =
  { leadId: string } | { dealId: string } | { contactId: string } | { companyId: string };

// `{ leadId: id }` etc., for a where or a create. Narrow on purpose: one link only.
export function parentLink({ kind, id }: ActivityParent): ParentWhere {
  return { [COLUMN[kind]]: id } as ParentWhere;
}

type Linked = Record<(typeof COLUMN)[ActivityParentKind], string | null>;

// The parent an existing row hangs on (the first link that is set; rows are written with one).
export function parentOf(row: Linked): ActivityParent | null {
  for (const kind of Object.keys(COLUMN) as ActivityParentKind[]) {
    const id = row[COLUMN[kind]];
    if (id) return { kind, id };
  }
  return null;
}
