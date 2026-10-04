'use strict';

/**
 * Registre des modèles et de leurs associations.
 *
 * Les colonnes de chaque modèle reflètent EXACTEMENT les migrations
 * (src/migrations) — seule source de vérité du schéma. Ce fichier ne déclare
 * que les liens utilisés par les `include` des services (jointures en une
 * requête, jamais de chargement ligne à ligne : pas de N+1).
 *
 * Aucune association ne pose de cascade applicative : les suppressions sont
 * logiques (paranoid) ou interdites par les clés étrangères.
 */

const sequelize = require('../config/db.js');

const Role = require('./role.model.js');
const User = require('./user.model.js');
const Owner = require('./owner.model.js');
const OwnerMember = require('./ownerMember.model.js');
const SubscriptionPlan = require('./subscriptionPlan.model.js');
const Subscription = require('./subscription.model.js');
const SubscriptionPayment = require('./subscriptionPayment.model.js');
const RefreshToken = require('./refreshToken.model.js');
const PasswordReset = require('./passwordReset.model.js');
const DeviceToken = require('./deviceToken.model.js');
const PlatformSetting = require('./platformSetting.model.js');
const IdempotencyKey = require('./idempotencyKey.model.js');
const Counter = require('./counter.model.js');
const AuditLog = require('./auditLog.model.js');
const Notification = require('./notification.model.js');
const WhatsappTemplate = require('./whatsappTemplate.model.js');
const Document = require('./document.model.js');
const MessageDelivery = require('./messageDelivery.model.js');
const Building = require('./building.model.js');
const Apartment = require('./apartment.model.js');
const Tenant = require('./tenant.model.js');
const TenantInvitation = require('./tenantInvitation.model.js');
const LeaseTemplate = require('./leaseTemplate.model.js');
const Lease = require('./lease.model.js');
const LeaseDocument = require('./leaseDocument.model.js');
const Contractor = require('./contractor.model.js');
const Incident = require('./incident.model.js');
const WorkOrder = require('./workOrder.model.js');
const WorkOrderEvent = require('./workOrderEvent.model.js');
const WorkPhoto = require('./workPhoto.model.js');
const MessageThread = require('./messageThread.model.js');
const Message = require('./message.model.js');
const Inspection = require('./inspection.model.js');
const InspectionRoom = require('./inspectionRoom.model.js');
const InspectionItem = require('./inspectionItem.model.js');
const InspectionPhoto = require('./inspectionPhoto.model.js');
const RentSchedule = require('./rentSchedule.model.js');
const ChargeInvoice = require('./chargeInvoice.model.js');
const ChargeAllocation = require('./chargeAllocation.model.js');
const Charge = require('./charge.model.js');
const PaymentProvider = require('./paymentProvider.model.js');
const PaymentTransaction = require('./paymentTransaction.model.js');
const RentPayment = require('./rentPayment.model.js');
const PaymentAllocation = require('./paymentAllocation.model.js');
const ReconciliationEntry = require('./reconciliationEntry.model.js');
const Receipt = require('./receipt.model.js');
const RentReminder = require('./rentReminder.model.js');
const ExpenseCategory = require('./expenseCategory.model.js');
const Expense = require('./expense.model.js');
const CashMovement = require('./cashMovement.model.js');
const Deposit = require('./deposit.model.js');
const DepositTransaction = require('./depositTransaction.model.js');

const fk = (foreignKey, as) => ({ foreignKey, as });

// ── Comptes et espaces propriétaires ──────────────────────────────────────
User.belongsTo(Role, fk('role_code', 'role'));
Owner.belongsTo(User, fk('user_id', 'titulaire'));
User.hasOne(Owner, fk('user_id', 'owner'));
OwnerMember.belongsTo(Owner, fk('owner_id', 'owner'));
OwnerMember.belongsTo(User, fk('user_id', 'user'));
OwnerMember.belongsTo(Role, fk('role_code', 'role'));
User.hasMany(OwnerMember, fk('user_id', 'memberships'));
Owner.hasMany(OwnerMember, fk('owner_id', 'members'));

Subscription.belongsTo(SubscriptionPlan, fk('plan_id', 'plan'));
Subscription.belongsTo(Owner, fk('owner_id', 'owner'));
Owner.hasMany(Subscription, fk('owner_id', 'subscriptions'));
SubscriptionPayment.belongsTo(SubscriptionPlan, fk('plan_id', 'plan'));
SubscriptionPayment.belongsTo(Owner, fk('owner_id', 'owner'));

RefreshToken.belongsTo(User, fk('user_id', 'user'));
Notification.belongsTo(User, fk('user_id', 'user'));
MessageDelivery.belongsTo(Notification, fk('notification_id', 'notification'));

// ── Patrimoine ────────────────────────────────────────────────────────────
Owner.hasMany(Building, fk('owner_id', 'buildings'));
Building.belongsTo(Owner, fk('owner_id', 'owner'));
Building.hasMany(Apartment, fk('building_id', 'apartments'));
Apartment.belongsTo(Building, fk('building_id', 'building'));

Tenant.belongsTo(User, fk('user_id', 'user'));
Tenant.belongsTo(Owner, fk('owner_id', 'owner'));
TenantInvitation.belongsTo(Tenant, fk('tenant_id', 'tenant'));

Lease.belongsTo(Apartment, fk('apartment_id', 'apartment'));
Lease.belongsTo(Tenant, fk('tenant_id', 'tenant'));
Lease.belongsTo(Owner, fk('owner_id', 'owner'));
Apartment.hasMany(Lease, fk('apartment_id', 'leases'));
Tenant.hasMany(Lease, fk('tenant_id', 'leases'));
Lease.hasOne(Deposit, fk('lease_id', 'deposit'));
Lease.hasMany(LeaseDocument, fk('lease_id', 'documents'));
LeaseDocument.belongsTo(LeaseTemplate, fk('template_id', 'template'));
LeaseDocument.belongsTo(Lease, fk('lease_id', 'lease'));

// ── Finances ──────────────────────────────────────────────────────────────
RentSchedule.belongsTo(Lease, fk('lease_id', 'lease'));
RentSchedule.belongsTo(Apartment, fk('apartment_id', 'apartment'));
RentSchedule.belongsTo(Tenant, fk('tenant_id', 'tenant'));
Lease.hasMany(RentSchedule, fk('lease_id', 'schedules'));
RentSchedule.hasMany(PaymentAllocation, fk('rent_schedule_id', 'allocations'));
RentSchedule.hasOne(Receipt, fk('rent_schedule_id', 'receipt'));

ChargeInvoice.belongsTo(Building, fk('building_id', 'building'));
ChargeInvoice.hasMany(ChargeAllocation, fk('charge_invoice_id', 'allocations'));
ChargeAllocation.belongsTo(ChargeInvoice, fk('charge_invoice_id', 'invoice'));
ChargeAllocation.belongsTo(Apartment, fk('apartment_id', 'apartment'));
ChargeAllocation.belongsTo(Lease, fk('lease_id', 'lease'));
Charge.belongsTo(ChargeInvoice, fk('charge_invoice_id', 'invoice'));
Charge.belongsTo(Apartment, fk('apartment_id', 'apartment'));
Charge.belongsTo(Tenant, fk('tenant_id', 'tenant'));
Charge.belongsTo(Lease, fk('lease_id', 'lease'));

PaymentTransaction.belongsTo(Tenant, fk('tenant_id', 'tenant'));
PaymentTransaction.belongsTo(Lease, fk('lease_id', 'lease'));
PaymentTransaction.belongsTo(RentSchedule, fk('rent_schedule_id', 'schedule'));
PaymentTransaction.belongsTo(Charge, fk('charge_id', 'charge'));
PaymentTransaction.belongsTo(PaymentProvider, fk('payment_provider_id', 'paymentProvider'));
PaymentTransaction.hasOne(RentPayment, fk('transaction_id', 'payment'));

RentPayment.belongsTo(Tenant, fk('tenant_id', 'tenant'));
RentPayment.belongsTo(Lease, fk('lease_id', 'lease'));
RentPayment.belongsTo(Apartment, fk('apartment_id', 'apartment'));
RentPayment.belongsTo(PaymentTransaction, fk('transaction_id', 'transaction'));
RentPayment.hasMany(PaymentAllocation, fk('rent_payment_id', 'allocations'));
PaymentAllocation.belongsTo(RentPayment, fk('rent_payment_id', 'payment'));
PaymentAllocation.belongsTo(RentSchedule, fk('rent_schedule_id', 'schedule'));
PaymentAllocation.belongsTo(Charge, fk('charge_id', 'charge'));

ReconciliationEntry.belongsTo(PaymentTransaction, fk('transaction_id', 'transaction'));
ReconciliationEntry.belongsTo(RentPayment, fk('rent_payment_id', 'payment'));
ReconciliationEntry.belongsTo(Tenant, fk('tenant_id', 'tenant'));
ReconciliationEntry.belongsTo(Lease, fk('lease_id', 'lease'));

Receipt.belongsTo(RentSchedule, fk('rent_schedule_id', 'schedule'));
Receipt.belongsTo(Tenant, fk('tenant_id', 'tenant'));
Receipt.belongsTo(Lease, fk('lease_id', 'lease'));

Expense.belongsTo(Building, fk('building_id', 'building'));
Expense.belongsTo(Apartment, fk('apartment_id', 'apartment'));
Expense.belongsTo(ExpenseCategory, fk('category_id', 'category'));
Expense.belongsTo(Contractor, fk('contractor_id', 'contractor'));
Expense.belongsTo(WorkOrder, fk('work_order_id', 'workOrder'));
CashMovement.belongsTo(Building, fk('building_id', 'building'));
CashMovement.belongsTo(Apartment, fk('apartment_id', 'apartment'));

Deposit.belongsTo(Lease, fk('lease_id', 'lease'));
Deposit.belongsTo(Tenant, fk('tenant_id', 'tenant'));
Deposit.hasMany(DepositTransaction, fk('deposit_id', 'transactions'));
DepositTransaction.belongsTo(Deposit, fk('deposit_id', 'deposit'));

// ── Opérations ────────────────────────────────────────────────────────────
Incident.belongsTo(Tenant, fk('tenant_id', 'tenant'));
Incident.belongsTo(Building, fk('building_id', 'building'));
Incident.belongsTo(Apartment, fk('apartment_id', 'apartment'));
Incident.hasMany(WorkOrder, fk('incident_id', 'workOrders'));

WorkOrder.belongsTo(Building, fk('building_id', 'building'));
WorkOrder.belongsTo(Apartment, fk('apartment_id', 'apartment'));
WorkOrder.belongsTo(Contractor, fk('contractor_id', 'contractor'));
WorkOrder.belongsTo(Incident, fk('incident_id', 'incident'));
WorkOrder.hasMany(WorkOrderEvent, fk('work_order_id', 'events'));
WorkOrder.hasMany(WorkPhoto, fk('work_order_id', 'photos'));
WorkOrder.hasMany(Expense, fk('work_order_id', 'expenses'));
WorkPhoto.belongsTo(Document, fk('document_id', 'document'));
Contractor.hasMany(WorkOrder, fk('contractor_id', 'workOrders'));

MessageThread.belongsTo(Tenant, fk('tenant_id', 'tenant'));
MessageThread.hasMany(Message, fk('thread_id', 'messages'));
Message.belongsTo(MessageThread, fk('thread_id', 'thread'));
Message.belongsTo(Document, fk('document_id', 'document'));

Inspection.belongsTo(Lease, fk('lease_id', 'lease'));
Inspection.belongsTo(Apartment, fk('apartment_id', 'apartment'));
Inspection.belongsTo(Tenant, fk('tenant_id', 'tenant'));
Inspection.hasMany(InspectionRoom, fk('inspection_id', 'rooms'));
InspectionRoom.hasMany(InspectionItem, fk('room_id', 'items'));
InspectionItem.belongsTo(InspectionRoom, fk('room_id', 'room'));
InspectionItem.hasMany(InspectionPhoto, fk('item_id', 'photos'));
InspectionPhoto.belongsTo(Document, fk('document_id', 'document'));

module.exports = {
  sequelize,
  Role, User, Owner, OwnerMember, SubscriptionPlan, Subscription, SubscriptionPayment,
  RefreshToken, PasswordReset, DeviceToken, PlatformSetting, IdempotencyKey, Counter,
  AuditLog, Notification, WhatsappTemplate, Document, MessageDelivery,
  Building, Apartment, Tenant, TenantInvitation, LeaseTemplate, Lease, LeaseDocument,
  Contractor, Incident, WorkOrder, WorkOrderEvent, WorkPhoto, MessageThread, Message,
  Inspection, InspectionRoom, InspectionItem, InspectionPhoto,
  RentSchedule, ChargeInvoice, ChargeAllocation, Charge,
  PaymentProvider, PaymentTransaction, RentPayment, PaymentAllocation, ReconciliationEntry, Receipt, RentReminder,
  ExpenseCategory, Expense, CashMovement, Deposit, DepositTransaction,
};
