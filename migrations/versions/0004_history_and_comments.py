"""history_and_comments

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-15 18:19:39.103150
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = '0004'
down_revision = '0003'
branch_labels = None
depends_on = None


def upgrade() -> None:
    
    op.create_table('historical_award',
    sa.Column('stable_key', sa.String(length=64), nullable=False),
    sa.Column('dataset', sa.String(length=64), nullable=False),
    sa.Column('dataset_as_of', sa.Date(), nullable=True),
    sa.Column('procurer', sa.String(length=100), nullable=False),
    sa.Column('tender_title', sa.Text(), nullable=False),
    sa.Column('tender_reference', sa.String(length=200), nullable=True),
    sa.Column('tender_family', sa.String(length=64), nullable=False),
    sa.Column('technology_as_stated', sa.String(length=100), nullable=False),
    sa.Column('bidder', sa.String(length=300), nullable=False),
    sa.Column('allocation', sa.String(length=64), nullable=False),
    sa.Column('capacity', sa.Float(), nullable=True),
    sa.Column('capacity_unit', sa.String(length=100), nullable=True),
    sa.Column('price', sa.Float(), nullable=True),
    sa.Column('price_unit', sa.String(length=100), nullable=True),
    sa.Column('currency', sa.String(length=8), nullable=True),
    sa.Column('adopted_capacity', sa.Float(), nullable=True),
    sa.Column('adopted_price', sa.Float(), nullable=True),
    sa.Column('result_kind', sa.String(length=32), nullable=False),
    sa.Column('status_as_stated', sa.String(length=100), nullable=False),
    sa.Column('award_date', sa.Date(), nullable=True),
    sa.Column('date_as_stated', sa.String(length=100), nullable=True),
    sa.Column('date_type', sa.String(length=100), nullable=True),
    sa.Column('contract_duration_years', sa.Integer(), nullable=True),
    sa.Column('storage_or_delivery_conditions', sa.Text(), nullable=True),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('verification', sa.Text(), nullable=True),
    sa.Column('flagged', sa.Boolean(), nullable=False),
    sa.Column('source_id', sa.String(length=32), nullable=False),
    sa.Column('source_url', sa.String(length=1000), nullable=True),
    sa.Column('source_sha256', sa.String(length=64), nullable=True),
    sa.Column('source_page', sa.String(length=32), nullable=True),
    sa.Column('source_checked_on', sa.Date(), nullable=True),
    sa.Column('related_url', sa.String(length=1000), nullable=True),
    sa.Column('raw', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('stable_key', name='uq_historical_award_key')
    )
    op.create_index(op.f('ix_historical_award_procurer'), 'historical_award', ['procurer'], unique=False)
    op.create_index(op.f('ix_historical_award_result_kind'), 'historical_award', ['result_kind'], unique=False)
    op.create_index(op.f('ix_historical_award_tender_family'), 'historical_award', ['tender_family'], unique=False)
    op.create_table('historical_source',
    sa.Column('dataset', sa.String(length=64), nullable=False),
    sa.Column('source_id', sa.String(length=32), nullable=False),
    sa.Column('name', sa.String(length=300), nullable=False),
    sa.Column('url', sa.String(length=1000), nullable=False),
    sa.Column('host', sa.String(length=200), nullable=False),
    sa.Column('kind', sa.String(length=32), nullable=False),
    sa.Column('sha256', sa.String(length=64), nullable=False),
    sa.Column('checked_on', sa.Date(), nullable=True),
    sa.Column('storage_key', sa.String(length=300), nullable=True),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('sha256', name='uq_historical_source_hash')
    )
    op.create_table('comment',
    sa.Column('tender_id', sa.String(length=32), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('object_type', sa.String(length=50), nullable=True),
    sa.Column('object_id', sa.String(length=32), nullable=True),
    sa.Column('parent_id', sa.String(length=32), nullable=True),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('mentions', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('decision', sa.String(length=32), nullable=True),
    sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('deleted_by', sa.String(length=32), nullable=True),
    sa.Column('corrects_comment_id', sa.String(length=32), nullable=True),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('organization_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['organization_id'], ['organization.id'], ),
    sa.ForeignKeyConstraint(['parent_id'], ['comment.id'], ),
    sa.ForeignKeyConstraint(['tender_id'], ['tender.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_comment_object_id'), 'comment', ['object_id'], unique=False)
    op.create_index(op.f('ix_comment_organization_id'), 'comment', ['organization_id'], unique=False)
    op.create_index(op.f('ix_comment_parent_id'), 'comment', ['parent_id'], unique=False)
    op.create_index(op.f('ix_comment_tender_id'), 'comment', ['tender_id'], unique=False)
    # Comments are never edited in place (deletion is a flag) and awards/sources are reference data written only by the importer.
    op.execute("""
    CREATE OR REPLACE FUNCTION fdre_comment_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'comments are never deleted; set deleted_at' USING ERRCODE = 'restrict_violation'; END IF;
      IF NEW.body IS DISTINCT FROM OLD.body OR NEW.tender_id IS DISTINCT FROM OLD.tender_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.kind IS DISTINCT FROM OLD.kind THEN
        RAISE EXCEPTION 'comment % is immutable; post a correction', OLD.id USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    """)
    op.execute("CREATE TRIGGER comment_guard BEFORE UPDATE OR DELETE ON comment FOR EACH ROW EXECUTE FUNCTION fdre_comment_guard();")
    


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS comment_guard ON comment")
    op.execute("DROP FUNCTION IF EXISTS fdre_comment_guard()")
    op.drop_index(op.f('ix_comment_tender_id'), table_name='comment')
    op.drop_index(op.f('ix_comment_parent_id'), table_name='comment')
    op.drop_index(op.f('ix_comment_organization_id'), table_name='comment')
    op.drop_index(op.f('ix_comment_object_id'), table_name='comment')
    op.drop_table('comment')
    op.drop_table('historical_source')
    op.drop_index(op.f('ix_historical_award_tender_family'), table_name='historical_award')
    op.drop_index(op.f('ix_historical_award_result_kind'), table_name='historical_award')
    op.drop_index(op.f('ix_historical_award_procurer'), table_name='historical_award')
    op.drop_table('historical_award')
    
