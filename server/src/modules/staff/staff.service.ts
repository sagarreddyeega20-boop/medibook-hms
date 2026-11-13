import type { Prisma, RoleCode } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { nextSequence } from '../../lib/sequence.js';
import { AuditAction, auditService } from '../audit/audit.service.js';
import { authService } from '../auth/auth.service.js';
import { PRIVILEGED_ROLES, STAFF_ID_CODES, type StaffRole } from '../auth/permissions.js';
import type { SessionData } from '../auth/session.service.js';

/**
 * Staff service — Staff records, departments, doctor profiles (created by Admin / Super Admin).
 * Owns: staff, departments
 * Other modules must call this service, never these tables directly.
 */

/** Hospital-issued staff ID: HMS-<ROLE CODE>-NNNN, e.g. HMS-DOC-0007 (counter per role). */
export const formatStaffCode = (role: StaffRole, n: number) => `HMS-${STAFF_ID_CODES[role]}-${String(n).padStart(4, '0')}`;

export async function nextStaffCode(role: StaffRole, tx: Prisma.TransactionClient = prisma) {
  return formatStaffCode(role, await nextSequence(`staff:${STAFF_ID_CODES[role]}`, tx));
}

export const ROLE_NAMES: Record<RoleCode, string> = {
  SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin', RECEPTIONIST: 'Receptionist', DOCTOR: 'Doctor', LAB_TECH: 'Lab technician',
  RADIOLOGY_TECH: 'Radiology technician', PHARMACIST: 'Pharmacist', ACCOUNTS: 'Accounts', PATIENT: 'Patient',
};

export type StaffStatus = 'ACTIVE' | 'INVITED' | 'LOCKED' | 'DEACTIVATED';

export interface Actor {
  session: SessionData;
  ip?: string | null;
}

const can = (a: Actor, p: string) => a.session.permissions.includes(p);

/** Admin-role changes (grant, change, deactivate) need staff:create_admin — Super Admin only. Super Admins are never managed here. */
function assertCanManage(actor: Actor, targetRole: RoleCode | null, newRole?: RoleCode) {
  if (targetRole === 'SUPER_ADMIN' || newRole === 'SUPER_ADMIN') throw AppError.forbidden('Super Admin accounts cannot be managed here');
  const privileged = [targetRole, newRole].some((r) => r && PRIVILEGED_ROLES.includes(r));
  if (privileged && !can(actor, 'staff:create_admin')) throw AppError.forbidden('Only a Super Admin can create or change Admin accounts');
}

const staffSelect = {
  id: true, userId: true, staffCode: true, fullName: true, isActive: true, createdAt: true,
  department: { select: { id: true, code: true, name: true } },
} satisfies Prisma.StaffSelect;

export const staffService = {
  findByStaffCode(staffCode: string) {
    return prisma.staff.findUnique({ where: { staffCode }, select: { userId: true, staffCode: true, fullName: true, isActive: true } });
  },

  profileByUserId(userId: string) {
    return prisma.staff.findUnique({ where: { userId }, select: { id: true, userId: true, staffCode: true, fullName: true, isActive: true } });
  },

  async namesByUserIds(userIds: string[]) {
    const rows = await prisma.staff.findMany({ where: { userId: { in: userIds } }, select: { userId: true, staffCode: true, fullName: true } });
    return new Map(rows.map((r) => [r.userId, { name: r.fullName, code: r.staffCode }]));
  },

  departments() {
    return prisma.department.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, select: { id: true, code: true, name: true, kind: true } });
  },

  async list() {
    const rows = await prisma.staff.findMany({ orderBy: { createdAt: 'desc' }, select: staffSelect });
    const accounts = await authService.accountSummaries(rows.map((r) => r.userId));
    return rows.map((r) => {
      const a = accounts.get(r.userId);
      const status: StaffStatus = !r.isActive ? 'DEACTIVATED' : a?.locked ? 'LOCKED' : !a?.hasPassword ? 'INVITED' : 'ACTIVE';
      return {
        id: r.id,
        staffCode: r.staffCode,
        fullName: r.fullName,
        email: a?.email ?? null,
        role: a?.role ?? null,
        department: r.department,
        status,
        lastLoginAt: a?.lastLoginAt ?? null,
        createdAt: r.createdAt,
      };
    });
  },

  async getById(id: string) {
    const row = (await this.list()).find((s) => s.id === id);
    if (!row) throw AppError.notFound('Staff member not found');
    return row;
  },

  async create(actor: Actor, input: { fullName: string; email: string; role: StaffRole; departmentId: string }) {
    assertCanManage(actor, null, input.role);
    if (!can(actor, 'staff:create')) throw AppError.forbidden();
    if (await authService.emailInUse(input.email)) throw AppError.conflict('This work email is already used by another account');
    const dept = await prisma.department.findFirst({ where: { id: input.departmentId, isActive: true } });
    if (!dept) throw AppError.badRequest('Choose a valid department');

    const created = await prisma.$transaction(async (tx) => {
      const user = await authService.createUserAccount({ email: input.email, role: input.role, createdById: actor.session.userId }, tx);
      const staffCode = await nextStaffCode(input.role, tx);
      const staff = await tx.staff.create({
        data: { userId: user.id, staffCode, fullName: input.fullName.trim(), departmentId: dept.id, designation: ROLE_NAMES[input.role] },
        select: { id: true, userId: true, staffCode: true, fullName: true },
      });
      await auditService.record(
        {
          actorId: actor.session.userId, action: AuditAction.STAFF_CREATED, entity: 'staff', entityId: staff.id, ip: actor.ip,
          metadata: { staffCode, role: input.role, department: dept.code },
        },
        tx,
      );
      return { ...staff, email: user.email };
    });

    await this.sendInvite(actor, created.id, { audit: false });
    return this.getById(created.id);
  },

  async sendInvite(actor: Actor, staffId: string, opts: { audit?: boolean } = {}) {
    const s = await this.getById(staffId);
    assertCanManage(actor, s.role);
    if (s.status === 'DEACTIVATED') throw AppError.badRequest('This account is deactivated');
    const result = await authService.sendSetPasswordLink({
      userId: (await prisma.staff.findUniqueOrThrow({ where: { id: staffId }, select: { userId: true } })).userId,
      email: s.email!, name: s.fullName, staffCode: s.staffCode, roleName: s.role ? ROLE_NAMES[s.role] : 'Staff',
    });
    if (opts.audit !== false) {
      await auditService.recordSafe({ actorId: actor.session.userId, action: AuditAction.STAFF_INVITE_SENT, entity: 'staff', entityId: staffId, ip: actor.ip, metadata: { staffCode: s.staffCode } });
    }
    return result;
  },

  async changeRole(actor: Actor, staffId: string, role: StaffRole) {
    const row = await prisma.staff.findUnique({ where: { id: staffId }, select: { userId: true, staffCode: true, isActive: true } });
    if (!row) throw AppError.notFound('Staff member not found');
    if (row.userId === actor.session.userId) throw AppError.forbidden('You cannot change your own role');
    if (!row.isActive) throw AppError.badRequest('This account is deactivated');
    const current = (await authService.accountSummaries([row.userId])).get(row.userId)?.role ?? null;
    assertCanManage(actor, current, role);
    if (current === role) return this.getById(staffId);

    await prisma.$transaction(async (tx) => {
      await authService.setRole(row.userId, role, tx);
      await tx.staff.update({ where: { id: staffId }, data: { designation: ROLE_NAMES[role] } });
      await auditService.record(
        { actorId: actor.session.userId, action: AuditAction.ROLE_CHANGED, entity: 'staff', entityId: staffId, ip: actor.ip, metadata: { staffCode: row.staffCode, from: current, to: role } },
        tx,
      );
    });
    await authService.revokeSessions(row.userId); // new permissions apply at next login
    return this.getById(staffId);
  },

  async deactivate(actor: Actor, staffId: string) {
    const row = await prisma.staff.findUnique({ where: { id: staffId }, select: { userId: true, staffCode: true, isActive: true } });
    if (!row) throw AppError.notFound('Staff member not found');
    if (row.userId === actor.session.userId) throw AppError.forbidden('You cannot deactivate your own account');
    const current = (await authService.accountSummaries([row.userId])).get(row.userId)?.role ?? null;
    assertCanManage(actor, current);
    if (!row.isActive) return this.getById(staffId);

    await prisma.$transaction(async (tx) => {
      await tx.staff.update({ where: { id: staffId }, data: { isActive: false } });
      await authService.disableUser(row.userId, tx);
      await auditService.record(
        { actorId: actor.session.userId, action: AuditAction.STAFF_DEACTIVATED, entity: 'staff', entityId: staffId, ip: actor.ip, metadata: { staffCode: row.staffCode, role: current } },
        tx,
      );
    });
    await authService.revokeSessions(row.userId);
    return this.getById(staffId);
  },
};
