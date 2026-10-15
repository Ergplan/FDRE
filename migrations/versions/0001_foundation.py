"""foundation

Revision ID: 0001
Revises: 
Create Date: 2026-10-15 16:09:45.015876
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = '0001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    
    op.create_table('app_user',
    sa.Column('email', sa.String(length=320), nullable=False),
    sa.Column('display_name', sa.String(length=200), nullable=False),
    sa.Column('password_hash', sa.String(length=200), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('email')
    )
    op.create_table('organization',
    sa.Column('slug', sa.String(length=64), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('slug')
    )
    op.create_table('audit_event',
    sa.Column('actor_user_id', sa.String(length=32), nullable=True),
    sa.Column('actor_label', sa.String(length=200), nullable=False),
    sa.Column('action', sa.String(length=64), nullable=False),
    sa.Column('object_type', sa.String(length=50), nullable=False),
    sa.Column('object_id', sa.String(length=32), nullable=False),
    sa.Column('object_version', sa.Integer(), nullable=True),
    sa.Column('before', postgresql.JSONB(none_as_null=True, astext_type=sa.Text()), nullable=True),
    sa.Column('after', postgresql.JSONB(none_as_null=True, astext_type=sa.Text()), nullable=True),
    sa.Column('request_id', sa.String(length=64), nullable=True),
    sa.Column('at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('organization_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['organization_id'], ['organization.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_audit_event_action'), 'audit_event', ['action'], unique=False)
    op.create_index(op.f('ix_audit_event_actor_user_id'), 'audit_event', ['actor_user_id'], unique=False)
    op.create_index(op.f('ix_audit_event_object_id'), 'audit_event', ['object_id'], unique=False)
    op.create_index(op.f('ix_audit_event_object_type'), 'audit_event', ['object_type'], unique=False)
    op.create_index(op.f('ix_audit_event_organization_id'), 'audit_event', ['organization_id'], unique=False)
    op.create_index(op.f('ix_audit_event_request_id'), 'audit_event', ['request_id'], unique=False)
    op.create_table('job',
    sa.Column('kind', sa.String(length=50), nullable=False),
    sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('attempts', sa.Integer(), nullable=False),
    sa.Column('max_attempts', sa.Integer(), nullable=False),
    sa.Column('run_after', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('lease_until', sa.DateTime(timezone=True), nullable=True),
    sa.Column('worker_id', sa.String(length=100), nullable=True),
    sa.Column('cancel_requested', sa.Boolean(), nullable=False),
    sa.Column('idempotency_key', sa.String(length=200), nullable=True),
    sa.Column('last_error', sa.Text(), nullable=True),
    sa.Column('progress', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('organization_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['organization_id'], ['organization.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('idempotency_key')
    )
    op.create_index(op.f('ix_job_organization_id'), 'job', ['organization_id'], unique=False)
    op.create_index(op.f('ix_job_status'), 'job', ['status'], unique=False)
    op.create_table('membership',
    sa.Column('organization_id', sa.String(length=32), nullable=False),
    sa.Column('user_id', sa.String(length=32), nullable=False),
    sa.Column('role', sa.String(length=32), nullable=False),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['organization_id'], ['organization.id'], ),
    sa.ForeignKeyConstraint(['user_id'], ['app_user.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('organization_id', 'user_id', name='uq_membership_org_user')
    )
    op.create_index(op.f('ix_membership_organization_id'), 'membership', ['organization_id'], unique=False)
    op.create_index(op.f('ix_membership_user_id'), 'membership', ['user_id'], unique=False)
    op.create_table('notification',
    sa.Column('user_id', sa.String(length=32), nullable=False),
    sa.Column('kind', sa.String(length=50), nullable=False),
    sa.Column('title', sa.String(length=300), nullable=False),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('link', sa.String(length=500), nullable=True),
    sa.Column('dedupe_key', sa.String(length=200), nullable=False),
    sa.Column('object_type', sa.String(length=50), nullable=True),
    sa.Column('object_id', sa.String(length=32), nullable=True),
    sa.Column('read_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('delivered_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('delivery_attempts', sa.Integer(), nullable=False),
    sa.Column('delivery_error', sa.Text(), nullable=True),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('organization_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['organization_id'], ['organization.id'], ),
    sa.ForeignKeyConstraint(['user_id'], ['app_user.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('organization_id', 'user_id', 'dedupe_key', name='uq_notification_dedupe')
    )
    op.create_index(op.f('ix_notification_organization_id'), 'notification', ['organization_id'], unique=False)
    op.create_index(op.f('ix_notification_user_id'), 'notification', ['user_id'], unique=False)
    op.create_table('tender',
    sa.Column('name', sa.String(length=300), nullable=False),
    sa.Column('procurer', sa.String(length=200), nullable=False),
    sa.Column('tender_family', sa.String(length=32), nullable=False),
    sa.Column('reference', sa.String(length=200), nullable=True),
    sa.Column('status', sa.String(length=32), nullable=False),
    sa.Column('engine_tender_id', sa.String(length=64), nullable=True),
    sa.Column('attributes', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('revision', sa.Integer(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_by', sa.String(length=32), nullable=True),
    sa.Column('notes', sa.Text(), nullable=False),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('organization_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['organization_id'], ['organization.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_tender_organization_id'), 'tender', ['organization_id'], unique=False)
    op.create_table('user_session',
    sa.Column('user_id', sa.String(length=32), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['user_id'], ['app_user.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_user_session_user_id'), 'user_session', ['user_id'], unique=False)
    op.create_table('scenario',
    sa.Column('tender_id', sa.String(length=32), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('workflow', sa.String(length=32), nullable=False),
    sa.Column('status', sa.String(length=32), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('revision', sa.Integer(), nullable=False),
    sa.Column('current_input_version_id', sa.String(length=32), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_by', sa.String(length=32), nullable=True),
    sa.Column('latest_run_id', sa.String(length=32), nullable=True),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('organization_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['organization_id'], ['organization.id'], ),
    sa.ForeignKeyConstraint(['tender_id'], ['tender.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_scenario_organization_id'), 'scenario', ['organization_id'], unique=False)
    op.create_index(op.f('ix_scenario_tender_id'), 'scenario', ['tender_id'], unique=False)
    op.create_table('tender_member',
    sa.Column('tender_id', sa.String(length=32), nullable=False),
    sa.Column('user_id', sa.String(length=32), nullable=False),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('organization_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['organization_id'], ['organization.id'], ),
    sa.ForeignKeyConstraint(['tender_id'], ['tender.id'], ),
    sa.ForeignKeyConstraint(['user_id'], ['app_user.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('tender_id', 'user_id', name='uq_tender_member_once')
    )
    op.create_index(op.f('ix_tender_member_organization_id'), 'tender_member', ['organization_id'], unique=False)
    op.create_index(op.f('ix_tender_member_tender_id'), 'tender_member', ['tender_id'], unique=False)
    op.create_index(op.f('ix_tender_member_user_id'), 'tender_member', ['user_id'], unique=False)
    op.create_table('scenario_input_version',
    sa.Column('scenario_id', sa.String(length=32), nullable=False),
    sa.Column('version_no', sa.Integer(), nullable=False),
    sa.Column('inputs', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('inputs_hash', sa.String(length=64), nullable=False),
    sa.Column('note', sa.Text(), nullable=False),
    sa.Column('changed_paths', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('organization_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['organization_id'], ['organization.id'], ),
    sa.ForeignKeyConstraint(['scenario_id'], ['scenario.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('scenario_id', 'version_no', name='uq_scenario_input_version_no')
    )
    op.create_index(op.f('ix_scenario_input_version_organization_id'), 'scenario_input_version', ['organization_id'], unique=False)
    op.create_index(op.f('ix_scenario_input_version_scenario_id'), 'scenario_input_version', ['scenario_id'], unique=False)
    op.create_table('run',
    sa.Column('tender_id', sa.String(length=32), nullable=False),
    sa.Column('scenario_id', sa.String(length=32), nullable=False),
    sa.Column('input_version_id', sa.String(length=32), nullable=False),
    sa.Column('kind', sa.String(length=32), nullable=False),
    sa.Column('status', sa.String(length=32), nullable=False),
    sa.Column('snapshot', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('result', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('metrics', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('validation', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('job_id', sa.String(length=32), nullable=True),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('stale', sa.Boolean(), nullable=False),
    sa.Column('stale_reason', sa.Text(), nullable=True),
    sa.Column('supersedes_run_id', sa.String(length=32), nullable=True),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('organization_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['input_version_id'], ['scenario_input_version.id'], ),
    sa.ForeignKeyConstraint(['organization_id'], ['organization.id'], ),
    sa.ForeignKeyConstraint(['scenario_id'], ['scenario.id'], ),
    sa.ForeignKeyConstraint(['supersedes_run_id'], ['run.id'], ),
    sa.ForeignKeyConstraint(['tender_id'], ['tender.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_run_organization_id'), 'run', ['organization_id'], unique=False)
    op.create_index(op.f('ix_run_scenario_id'), 'run', ['scenario_id'], unique=False)
    op.create_index(op.f('ix_run_status'), 'run', ['status'], unique=False)
    op.create_index(op.f('ix_run_tender_id'), 'run', ['tender_id'], unique=False)
    op.create_table('run_artifact',
    sa.Column('run_id', sa.String(length=32), nullable=False),
    sa.Column('kind', sa.String(length=64), nullable=False),
    sa.Column('filename', sa.String(length=300), nullable=False),
    sa.Column('content_type', sa.String(length=100), nullable=False),
    sa.Column('sha256', sa.String(length=64), nullable=False),
    sa.Column('size_bytes', sa.Integer(), nullable=False),
    sa.Column('storage_key', sa.String(length=300), nullable=False),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('organization_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['organization_id'], ['organization.id'], ),
    sa.ForeignKeyConstraint(['run_id'], ['run.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_run_artifact_organization_id'), 'run_artifact', ['organization_id'], unique=False)
    op.create_index(op.f('ix_run_artifact_run_id'), 'run_artifact', ['run_id'], unique=False)

    op.create_foreign_key('fk_scenario_current_input', 'scenario', 'scenario_input_version', ['current_input_version_id'], ['id'])

    # ### immutability guards: enforced in the database, not only in code ###
    op.execute("""
    CREATE OR REPLACE FUNCTION fdre_refuse_change() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'table % is append-only (% refused)', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
    END $$ LANGUAGE plpgsql;
    """)
    op.execute("""
    CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON audit_event
      FOR EACH ROW EXECUTE FUNCTION fdre_refuse_change();
    """)
    op.execute("""
    CREATE TRIGGER scenario_input_version_immutable BEFORE UPDATE OR DELETE ON scenario_input_version
      FOR EACH ROW EXECUTE FUNCTION fdre_refuse_change();
    """)
    op.execute("""
    CREATE OR REPLACE FUNCTION fdre_run_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'run rows are never deleted' USING ERRCODE = 'restrict_violation';
      END IF;
      IF OLD.status IN ('succeeded','infeasible','time_limited','failed','cancelled') THEN
        IF NEW.status IS DISTINCT FROM OLD.status
           OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
           OR NEW.result IS DISTINCT FROM OLD.result
           OR NEW.metrics IS DISTINCT FROM OLD.metrics
           OR NEW.validation IS DISTINCT FROM OLD.validation
           OR NEW.input_version_id IS DISTINCT FROM OLD.input_version_id
           OR NEW.kind IS DISTINCT FROM OLD.kind
           OR NEW.scenario_id IS DISTINCT FROM OLD.scenario_id
           OR NEW.tender_id IS DISTINCT FROM OLD.tender_id
           OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
           OR NEW.started_at IS DISTINCT FROM OLD.started_at
           OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
           OR NEW.error IS DISTINCT FROM OLD.error THEN
          RAISE EXCEPTION 'completed run % is immutable; only stale, stale_reason and supersedes_run_id may change', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
      END IF;
      IF NEW.snapshot IS DISTINCT FROM OLD.snapshot THEN
        RAISE EXCEPTION 'run snapshot is immutable' USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    """)
    op.execute("""
    CREATE TRIGGER run_guard BEFORE UPDATE OR DELETE ON run
      FOR EACH ROW EXECUTE FUNCTION fdre_run_guard();
    """)
    op.execute("""
    CREATE TRIGGER run_artifact_immutable BEFORE UPDATE OR DELETE ON run_artifact
      FOR EACH ROW EXECUTE FUNCTION fdre_refuse_change();
    """)
    


def downgrade() -> None:
    op.drop_constraint('fk_scenario_current_input', 'scenario', type_='foreignkey')
    op.execute("DROP TRIGGER IF EXISTS run_artifact_immutable ON run_artifact")
    op.execute("DROP TRIGGER IF EXISTS run_guard ON run")
    op.execute("DROP TRIGGER IF EXISTS scenario_input_version_immutable ON scenario_input_version")
    op.execute("DROP TRIGGER IF EXISTS audit_event_append_only ON audit_event")
    op.execute("DROP FUNCTION IF EXISTS fdre_run_guard()")
    op.execute("DROP FUNCTION IF EXISTS fdre_refuse_change()")
    op.drop_index(op.f('ix_run_artifact_run_id'), table_name='run_artifact')
    op.drop_index(op.f('ix_run_artifact_organization_id'), table_name='run_artifact')
    op.drop_table('run_artifact')
    op.drop_index(op.f('ix_run_tender_id'), table_name='run')
    op.drop_index(op.f('ix_run_status'), table_name='run')
    op.drop_index(op.f('ix_run_scenario_id'), table_name='run')
    op.drop_index(op.f('ix_run_organization_id'), table_name='run')
    op.drop_table('run')
    op.drop_index(op.f('ix_scenario_input_version_scenario_id'), table_name='scenario_input_version')
    op.drop_index(op.f('ix_scenario_input_version_organization_id'), table_name='scenario_input_version')
    op.drop_table('scenario_input_version')
    op.drop_index(op.f('ix_tender_member_user_id'), table_name='tender_member')
    op.drop_index(op.f('ix_tender_member_tender_id'), table_name='tender_member')
    op.drop_index(op.f('ix_tender_member_organization_id'), table_name='tender_member')
    op.drop_table('tender_member')
    op.drop_index(op.f('ix_scenario_tender_id'), table_name='scenario')
    op.drop_index(op.f('ix_scenario_organization_id'), table_name='scenario')
    op.drop_table('scenario')
    op.drop_index(op.f('ix_user_session_user_id'), table_name='user_session')
    op.drop_table('user_session')
    op.drop_index(op.f('ix_tender_organization_id'), table_name='tender')
    op.drop_table('tender')
    op.drop_index(op.f('ix_notification_user_id'), table_name='notification')
    op.drop_index(op.f('ix_notification_organization_id'), table_name='notification')
    op.drop_table('notification')
    op.drop_index(op.f('ix_membership_user_id'), table_name='membership')
    op.drop_index(op.f('ix_membership_organization_id'), table_name='membership')
    op.drop_table('membership')
    op.drop_index(op.f('ix_job_status'), table_name='job')
    op.drop_index(op.f('ix_job_organization_id'), table_name='job')
    op.drop_table('job')
    op.drop_index(op.f('ix_audit_event_request_id'), table_name='audit_event')
    op.drop_index(op.f('ix_audit_event_organization_id'), table_name='audit_event')
    op.drop_index(op.f('ix_audit_event_object_type'), table_name='audit_event')
    op.drop_index(op.f('ix_audit_event_object_id'), table_name='audit_event')
    op.drop_index(op.f('ix_audit_event_actor_user_id'), table_name='audit_event')
    op.drop_index(op.f('ix_audit_event_action'), table_name='audit_event')
    op.drop_table('audit_event')
    op.drop_table('organization')
    op.drop_table('app_user')
    
