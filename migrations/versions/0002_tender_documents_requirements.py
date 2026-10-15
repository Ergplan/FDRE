"""tender_documents_requirements

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-15 17:13:43.835770
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = '0002'
down_revision = '0001'
branch_labels = None
depends_on = None


def upgrade() -> None:
    
    op.create_table('review_task',
    sa.Column('tender_id', sa.String(length=32), nullable=False),
    sa.Column('assignee_user_id', sa.String(length=32), nullable=True),
    sa.Column('kind', sa.String(length=50), nullable=False),
    sa.Column('title', sa.String(length=300), nullable=False),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('object_type', sa.String(length=50), nullable=True),
    sa.Column('object_id', sa.String(length=32), nullable=True),
    sa.Column('dedupe_key', sa.String(length=200), nullable=True),
    sa.Column('status', sa.String(length=32), nullable=False),
    sa.Column('due_on', sa.Date(), nullable=True),
    sa.Column('completed_by', sa.String(length=32), nullable=True),
    sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('organization_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['organization_id'], ['organization.id'], ),
    sa.ForeignKeyConstraint(['tender_id'], ['tender.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('dedupe_key')
    )
    op.create_index(op.f('ix_review_task_assignee_user_id'), 'review_task', ['assignee_user_id'], unique=False)
    op.create_index(op.f('ix_review_task_organization_id'), 'review_task', ['organization_id'], unique=False)
    op.create_index(op.f('ix_review_task_tender_id'), 'review_task', ['tender_id'], unique=False)
    op.create_table('tender_document',
    sa.Column('tender_id', sa.String(length=32), nullable=False),
    sa.Column('filename', sa.String(length=300), nullable=False),
    sa.Column('sha256', sa.String(length=64), nullable=False),
    sa.Column('size_bytes', sa.Integer(), nullable=False),
    sa.Column('content_type', sa.String(length=100), nullable=False),
    sa.Column('storage_key', sa.String(length=300), nullable=False),
    sa.Column('kind', sa.String(length=32), nullable=False),
    sa.Column('role', sa.String(length=32), nullable=False),
    sa.Column('publication_order', sa.Integer(), nullable=False),
    sa.Column('issued_on', sa.Date(), nullable=True),
    sa.Column('effective_on', sa.Date(), nullable=True),
    sa.Column('supersedes_document_id', sa.String(length=32), nullable=True),
    sa.Column('source_url', sa.String(length=1000), nullable=True),
    sa.Column('page_count', sa.Integer(), nullable=True),
    sa.Column('status', sa.String(length=32), nullable=False),
    sa.Column('extractor', sa.String(length=100), nullable=True),
    sa.Column('engine_tender_id', sa.String(length=64), nullable=True),
    sa.Column('engine_version_no', sa.Integer(), nullable=True),
    sa.Column('engine_document_id', sa.String(length=64), nullable=True),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('organization_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['organization_id'], ['organization.id'], ),
    sa.ForeignKeyConstraint(['supersedes_document_id'], ['tender_document.id'], ),
    sa.ForeignKeyConstraint(['tender_id'], ['tender.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('tender_id', 'sha256', name='uq_tender_document_hash')
    )
    op.create_index(op.f('ix_tender_document_organization_id'), 'tender_document', ['organization_id'], unique=False)
    op.create_index(op.f('ix_tender_document_tender_id'), 'tender_document', ['tender_id'], unique=False)
    op.create_table('requirement_version',
    sa.Column('tender_id', sa.String(length=32), nullable=False),
    sa.Column('version_no', sa.Integer(), nullable=False),
    sa.Column('status', sa.String(length=32), nullable=False),
    sa.Column('based_on_document_id', sa.String(length=32), nullable=True),
    sa.Column('previous_version_id', sa.String(length=32), nullable=True),
    sa.Column('created_from', sa.String(length=32), nullable=False),
    sa.Column('note', sa.Text(), nullable=False),
    sa.Column('locked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('approved_by', sa.String(length=32), nullable=True),
    sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('conflicts', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('organization_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['based_on_document_id'], ['tender_document.id'], ),
    sa.ForeignKeyConstraint(['organization_id'], ['organization.id'], ),
    sa.ForeignKeyConstraint(['previous_version_id'], ['requirement_version.id'], ),
    sa.ForeignKeyConstraint(['tender_id'], ['tender.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('tender_id', 'version_no', name='uq_requirement_version_no')
    )
    op.create_index(op.f('ix_requirement_version_organization_id'), 'requirement_version', ['organization_id'], unique=False)
    op.create_index(op.f('ix_requirement_version_tender_id'), 'requirement_version', ['tender_id'], unique=False)
    op.create_table('amendment_impact',
    sa.Column('tender_id', sa.String(length=32), nullable=False),
    sa.Column('document_id', sa.String(length=32), nullable=False),
    sa.Column('from_requirement_version_id', sa.String(length=32), nullable=True),
    sa.Column('to_requirement_version_id', sa.String(length=32), nullable=False),
    sa.Column('changes', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('affected_scenario_ids', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('affected_run_ids', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('owner_user_id', sa.String(length=32), nullable=True),
    sa.Column('status', sa.String(length=32), nullable=False),
    sa.Column('applied_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('summary', sa.Text(), nullable=False),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('organization_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['document_id'], ['tender_document.id'], ),
    sa.ForeignKeyConstraint(['from_requirement_version_id'], ['requirement_version.id'], ),
    sa.ForeignKeyConstraint(['organization_id'], ['organization.id'], ),
    sa.ForeignKeyConstraint(['tender_id'], ['tender.id'], ),
    sa.ForeignKeyConstraint(['to_requirement_version_id'], ['requirement_version.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_amendment_impact_organization_id'), 'amendment_impact', ['organization_id'], unique=False)
    op.create_index(op.f('ix_amendment_impact_tender_id'), 'amendment_impact', ['tender_id'], unique=False)
    op.create_table('requirement',
    sa.Column('requirement_version_id', sa.String(length=32), nullable=False),
    sa.Column('tender_id', sa.String(length=32), nullable=False),
    sa.Column('field_path', sa.String(length=200), nullable=False),
    sa.Column('label', sa.String(length=300), nullable=False),
    sa.Column('section', sa.String(length=50), nullable=False),
    sa.Column('value_type', sa.String(length=32), nullable=False),
    sa.Column('value', postgresql.JSONB(none_as_null=True, astext_type=sa.Text()), nullable=True),
    sa.Column('unit', sa.String(length=100), nullable=True),
    sa.Column('effective_date', sa.Date(), nullable=True),
    sa.Column('confidence', sa.Float(), nullable=True),
    sa.Column('provenance', sa.String(length=32), nullable=False),
    sa.Column('extractor', sa.String(length=100), nullable=True),
    sa.Column('source_document_id', sa.String(length=32), nullable=True),
    sa.Column('evidence', postgresql.JSONB(none_as_null=True, astext_type=sa.Text()), nullable=True),
    sa.Column('alternatives', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('review_state', sa.String(length=32), nullable=False),
    sa.Column('reviewed_by', sa.String(length=32), nullable=True),
    sa.Column('reviewed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('review_note', sa.Text(), nullable=False),
    sa.Column('original_value', postgresql.JSONB(none_as_null=True, astext_type=sa.Text()), nullable=True),
    sa.Column('change_kind', sa.String(length=32), nullable=False),
    sa.Column('supersedes_requirement_id', sa.String(length=32), nullable=True),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('organization_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['organization_id'], ['organization.id'], ),
    sa.ForeignKeyConstraint(['requirement_version_id'], ['requirement_version.id'], ),
    sa.ForeignKeyConstraint(['source_document_id'], ['tender_document.id'], ),
    sa.ForeignKeyConstraint(['supersedes_requirement_id'], ['requirement.id'], ),
    sa.ForeignKeyConstraint(['tender_id'], ['tender.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('requirement_version_id', 'field_path', name='uq_requirement_version_field')
    )
    op.create_index(op.f('ix_requirement_organization_id'), 'requirement', ['organization_id'], unique=False)
    op.create_index(op.f('ix_requirement_requirement_version_id'), 'requirement', ['requirement_version_id'], unique=False)
    op.create_index(op.f('ix_requirement_tender_id'), 'requirement', ['tender_id'], unique=False)
    op.create_table('rule_set_version',
    sa.Column('tender_id', sa.String(length=32), nullable=False),
    sa.Column('requirement_version_id', sa.String(length=32), nullable=False),
    sa.Column('version_no', sa.Integer(), nullable=False),
    sa.Column('status', sa.String(length=32), nullable=False),
    sa.Column('rules', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('unsupported_count', sa.Integer(), nullable=False),
    sa.Column('certifiable', sa.Boolean(), nullable=False),
    sa.Column('blocking', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('compiler_version', sa.String(length=50), nullable=False),
    sa.Column('approved_by', sa.String(length=32), nullable=True),
    sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('organization_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['organization_id'], ['organization.id'], ),
    sa.ForeignKeyConstraint(['requirement_version_id'], ['requirement_version.id'], ),
    sa.ForeignKeyConstraint(['tender_id'], ['tender.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_rule_set_version_organization_id'), 'rule_set_version', ['organization_id'], unique=False)
    op.create_index(op.f('ix_rule_set_version_tender_id'), 'rule_set_version', ['tender_id'], unique=False)
    op.add_column('audit_event', sa.Column('tender_id', sa.String(length=32), nullable=True))
    op.create_index(op.f('ix_audit_event_tender_id'), 'audit_event', ['tender_id'], unique=False)

    # Locked requirement versions: rows of an approved or superseded version never change.
    op.execute("""
    CREATE OR REPLACE FUNCTION fdre_requirement_guard() RETURNS trigger AS $$
    DECLARE locked timestamptz;
    BEGIN
      SELECT locked_at INTO locked FROM requirement_version WHERE id = OLD.requirement_version_id;
      IF locked IS NOT NULL THEN
        RAISE EXCEPTION 'requirement version % is locked; requirements are immutable', OLD.requirement_version_id
          USING ERRCODE = 'restrict_violation';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    """)
    op.execute("CREATE TRIGGER requirement_guard BEFORE UPDATE OR DELETE ON requirement FOR EACH ROW EXECUTE FUNCTION fdre_requirement_guard();")
    op.execute("CREATE TRIGGER tender_document_immutable BEFORE DELETE ON tender_document FOR EACH ROW EXECUTE FUNCTION fdre_refuse_change();")
    op.execute("CREATE TRIGGER amendment_impact_no_delete BEFORE DELETE ON amendment_impact FOR EACH ROW EXECUTE FUNCTION fdre_refuse_change();")
    


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS amendment_impact_no_delete ON amendment_impact")
    op.execute("DROP TRIGGER IF EXISTS tender_document_immutable ON tender_document")
    op.execute("DROP TRIGGER IF EXISTS requirement_guard ON requirement")
    op.execute("DROP FUNCTION IF EXISTS fdre_requirement_guard()")
    op.drop_index(op.f('ix_audit_event_tender_id'), table_name='audit_event')
    op.drop_column('audit_event', 'tender_id')
    op.drop_index(op.f('ix_rule_set_version_tender_id'), table_name='rule_set_version')
    op.drop_index(op.f('ix_rule_set_version_organization_id'), table_name='rule_set_version')
    op.drop_table('rule_set_version')
    op.drop_index(op.f('ix_requirement_tender_id'), table_name='requirement')
    op.drop_index(op.f('ix_requirement_requirement_version_id'), table_name='requirement')
    op.drop_index(op.f('ix_requirement_organization_id'), table_name='requirement')
    op.drop_table('requirement')
    op.drop_index(op.f('ix_amendment_impact_tender_id'), table_name='amendment_impact')
    op.drop_index(op.f('ix_amendment_impact_organization_id'), table_name='amendment_impact')
    op.drop_table('amendment_impact')
    op.drop_index(op.f('ix_requirement_version_tender_id'), table_name='requirement_version')
    op.drop_index(op.f('ix_requirement_version_organization_id'), table_name='requirement_version')
    op.drop_table('requirement_version')
    op.drop_index(op.f('ix_tender_document_tender_id'), table_name='tender_document')
    op.drop_index(op.f('ix_tender_document_organization_id'), table_name='tender_document')
    op.drop_table('tender_document')
    op.drop_index(op.f('ix_review_task_tender_id'), table_name='review_task')
    op.drop_index(op.f('ix_review_task_organization_id'), table_name='review_task')
    op.drop_index(op.f('ix_review_task_assignee_user_id'), table_name='review_task')
    op.drop_table('review_task')
    
