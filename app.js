import { CronJob } from 'cron';
import { app } from 'mu';
import {
  addPackage,
  createMetadata,
  createZipFile,
  cleanup,
  isRunning,
  updateInternalReportStatus,
  fetchReportsToBePackaged,
  fetchFilesForReport,
  STATUS_PROCESSING,
  STATUS_PACKAGED
} from './support';
import request from 'request';

/** Schedule export cron job */
const cronFrequency = process.env.PACKAGE_CRON_PATTERN || '0 */12 * * * *';


cleanup();

new CronJob(cronFrequency, function() {
  console.log(`packaging triggered by cron job at ${new Date().toISOString()}`);
  request.post('http://localhost/package-bbcdr-reports/');
}, null, true);


app.post('/package-bbcdr-reports/', async function( req, res ) {
  try {
    if (await isRunning())
      return res.status(503).end();
    const reports = await fetchReportsToBePackaged();
    reports.forEach( async (report) => {
      console.log(report);
      updateInternalReportStatus(report, STATUS_PROCESSING);
      const files = await fetchFilesForReport(report);
      const borderel = createMetadata(report, files);
      const zipFile = createZipFile(report.id, files, borderel);
      addPackage(report, zipFile);
      await updateInternalReportStatus(report, STATUS_PACKAGED);
    });
    res.status(202).send({status:202, title: 'processing'});
  }
  catch(e) {
    console.log(e);
    res.status(500).send({status: 500, title: e.message});
  }
});
