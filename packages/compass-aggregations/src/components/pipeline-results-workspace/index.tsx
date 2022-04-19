import React, { useState } from 'react';
import { connect } from 'react-redux';
import type { Document } from 'mongodb';
import {
  css,
  cx,
  spacing,
  Body,
  uiColors,
  CancelLoader,
} from '@mongodb-js/compass-components';

import type { RootState } from '../../modules';
import { cancelAggregation } from '../../modules/aggregation';

import type { ResultsViewType } from './pipeline-results-list';
import PipelineResultsList from './pipeline-results-list';
import PipelinePagination from './pipeline-pagination';
import PipelineEmptyResults from './pipeline-empty-results';
import PipelineResultsViewControls from './pipeline-results-view-controls';

type PipelineResultsWorkspaceProps = {
  documents: Document[];
  loading: boolean;
  hasEmptyResults: boolean;
  error?: string;
  onCancel: () => void;
};

const containerStyles = css({
  overflow: 'hidden',
  height: '100vh',
  display: 'grid',
  gap: spacing[2],
  gridTemplateAreas: `
    "header"
    "results"
  `,
  gridTemplateRows: 'min-content',
  marginTop: spacing[2],
  marginBottom: spacing[3],
});

const headerStyles = css({
  paddingLeft: spacing[3] + spacing[1],
  paddingRight: spacing[5] + spacing[1],
  gridArea: 'header',
  display: 'flex',
  gap: spacing[2],
  justifyContent: 'flex-end',
  alignItems: 'center',
});

const resultsStyles = css({
  gridArea: 'results',
  overflowY: 'auto',
});

const centeredContentStyles = css({
  height: '100%',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
});

const errorMessageStyles = css({
  color: uiColors.red.base,
});

export const PipelineResultsWorkspace: React.FunctionComponent<PipelineResultsWorkspaceProps> =
  ({ documents, hasEmptyResults, loading, error, onCancel }) => {
    const [resultsViewType, setResultsViewType] =
      useState<ResultsViewType>('document');

    const isResultsListHidden = loading || Boolean(error) || hasEmptyResults;

    return (
      <div data-testid="pipeline-results-workspace" className={containerStyles}>
        <div className={headerStyles}>
          <PipelinePagination />
          <PipelineResultsViewControls
            value={resultsViewType}
            onChange={setResultsViewType}
          />
        </div>
        <div className={resultsStyles}>
          <PipelineResultsList documents={documents} view={resultsViewType} />
          <div className={cx(isResultsListHidden && centeredContentStyles)}>
            {loading && (
              <CancelLoader
                dataTestId="pipeline-results-loader"
                progressText="Running aggregation"
                cancelText="Stop"
                onCancel={() => onCancel()}
              />
            )}
            {hasEmptyResults && <PipelineEmptyResults />}
            {error && <Body className={errorMessageStyles}>{error}</Body>}
          </div>
        </div>
      </div>
    );
  };

const mapState = ({
  aggregation: { documents, loading, error },
}: RootState) => ({
  documents,
  error,
  loading,
  hasEmptyResults: documents.length === 0 && !error && !loading,
});

const mapDispatch = {
  onCancel: cancelAggregation,
};

export default connect(mapState, mapDispatch)(PipelineResultsWorkspace);