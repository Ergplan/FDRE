"""profiles

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-15 17:39:17.005352
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = '0003'
down_revision = '0002'
branch_labels = None
depends_on = None


def upgrade() -> None:
    
    op.create_table('profile',
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('kind', sa.String(length=32), nullable=False),
    sa.Column('technology', sa.String(length=32), nullable=True),
    sa.Column('basis', sa.String(length=32), nullable=False),
    sa.Column('capacity_basis', sa.String(length=32), nullable=True),
    sa.Column('capacity_mw', sa.Float(), nullable=True),
    sa.Column('measured_at', sa.String(length=32), nullable=True),
    sa.Column('p_level', sa.String(length=8), nullable=True),
    sa.Column('timezone', sa.String(length=64), nullable=False),
    sa.Column('resolution_minutes', sa.Integer(), nullable=False),
    sa.Column('year', sa.Integer(), nullable=True),
    sa.Column('sha256', sa.String(length=64), nullable=False),
    sa.Column('source_sha256', sa.String(length=64), nullable=False),
    sa.Column('storage_key', sa.String(length=300), nullable=False),
    sa.Column('hourly', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('stats', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('report', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('provenance', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('note', sa.Text(), nullable=False),
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('organization_id', sa.String(length=32), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('created_by', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['organization_id'], ['organization.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('organization_id', 'sha256', name='uq_profile_org_hash')
    )
    op.create_index(op.f('ix_profile_organization_id'), 'profile', ['organization_id'], unique=False)
    op.execute("CREATE TRIGGER profile_immutable BEFORE UPDATE OR DELETE ON profile FOR EACH ROW EXECUTE FUNCTION fdre_refuse_change();")
    


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS profile_immutable ON profile")
    op.drop_index(op.f('ix_profile_organization_id'), table_name='profile')
    op.drop_table('profile')
    
